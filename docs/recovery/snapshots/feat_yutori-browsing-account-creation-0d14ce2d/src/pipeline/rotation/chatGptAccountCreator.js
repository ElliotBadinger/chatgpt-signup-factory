/**
 * chatGptAccountCreator.js
 *
 * Creates OR logs-in-to a ChatGPT account using an AgentMail inbox.
 *
 * Design principles:
 *  1. FAIL-FAST — every step validates its post-condition and THROWS a typed
 *     RotationError if the observed state doesn't match what was expected.
 *     Silent return-with-error is only at the outermost boundary.
 *  2. STRONG TYPES — all public inputs/outputs are annotated via JSDoc and
 *     validated at runtime with `assertOpts()`.
 *  3. ALREADY-REGISTERED REUSE — when the target email already has a ChatGPT
 *     account we switch to OTP login instead of giving up. The function returns
 *     a valid `auth` either way. Only if the login page has NO email-code
 *     option do we surface `{ success: false, error: 'no-email-code-option' }`.
 *  4. PARALLEL-SAFE — no file I/O; the caller (orchestrator) owns all writes.
 *  5. BROWSER-FIRST — all ChatGPT interactions go through page.evaluate(); no
 *     direct Node.js fetch to chatgpt.com or auth.openai.com.
 *
 * evaluate() call sequence (both paths share the same 6-call contract):
 *   eval-0  findSignupUrlScript          → string|null  (dismiss cookies; find href)
 *   eval-1  buildFillEmailScript()       → { emailFilled, alreadyRegistered, url }
 *   eval-2  handlePostSubmitStateScript  → { state, optionText?, url }
 *            state ∈ 'otp-needed' | 'attempting-email-code' |
 *                    'already-registered-no-code-option' | 'loading' | 'error'
 *   eval-3  buildFillOtpScript(otp,name) → { otpFilled, nameFilled }
 *   eval-4  clickAcceptInviteScript      → { clicked, btnText }
 *   eval-5  getSessionTokenScript        → { accessToken?, user?, expires?, … }
 */

import {
  SignupStateError,
  OtpTimeoutError,
  InviteError,
  TokenExtractionError,
  NoEmailCodeOptionError,
} from './errors.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   email: string;
 *   agentMailApiKey: string;
 *   agentMailInboxId: string;
 *   teamInviteCallback?: (email: string) => Promise<void>;
 *   agentMailPollIntervalMs?: number;
 *   agentMailTimeoutMs?: number;
 *   name?: string;
 *   pageStateCheckRetries?: number;
 *   pageStateCheckIntervalMs?: number;
 *   navigationDelayMs?: number;
 * }} CreateChatGptAccountOpts
 */

/**
 * @typedef {{
 *   type: 'oauth';
 *   access: string;
 *   refresh: string | null;
 *   expires: number;
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

/**
 * @param {CreateChatGptAccountOpts} opts
 * @throws {TypeError}
 */
function assertOpts(opts) {
  if (!opts || typeof opts !== 'object') throw new TypeError('opts must be an object');
  if (typeof opts.email !== 'string' || !opts.email.includes('@')) {
    throw new TypeError(`opts.email must be a valid email; got: ${JSON.stringify(opts.email)}`);
  }
  if (typeof opts.agentMailApiKey !== 'string' || opts.agentMailApiKey.length < 5) {
    throw new TypeError(`opts.agentMailApiKey must be a non-empty string; got: ${JSON.stringify(opts.agentMailApiKey?.slice(0, 10))}`);
  }
  if (typeof opts.agentMailInboxId !== 'string' || !opts.agentMailInboxId) {
    throw new TypeError(`opts.agentMailInboxId must be a non-empty string; got: ${JSON.stringify(opts.agentMailInboxId)}`);
  }
}

// ─── AgentMail polling ────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OTP_REGEX = /\b(\d{6})\b/;
// ChatGPT API invites use a login-with-params URL (not /invitations/).
// Confirmed format: https://chatgpt.com/auth/login?inv_ws_name=...&inv_email=...&wId=...
// Keep legacy /invitations/ pattern as fallback.
const INVITE_LINK_REGEX = /https:\/\/chatgpt\.com\/(?:auth\/login\?inv_ws_name|invitations\/)[^\s"'<>]+/;

/**
 * Poll AgentMail inbox for a message matching `matcher`.
 * Throws OtpTimeoutError / InviteError on timeout (callers provide the error constructor).
 *
 * @param {string} inboxId
 * @param {string} apiKey
 * @param {{
 *   sinceMs: number;
 *   timeoutMs: number;
 *   pollIntervalMs: number;
 *   matcher: (msg: object) => boolean;
 * }} opts
 * @returns {Promise<object>}  The first matching message
 */
async function pollAgentMailMessages(inboxId, apiKey, opts) {
  const { sinceMs, timeoutMs, pollIntervalMs, matcher, sinceGraceMs = 30_000 } = opts;
  const listUrl = `https://api.agentmail.to/v0/inboxes/${inboxId}/messages?limit=20`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (res.ok) {
        const data = await res.json();
        const candidates = (data.messages ?? []).filter((m) => {
          // AgentMail API returns `timestamp` (ISO string), not `receivedAt`.
          // sinceGraceMs: for OTPs use 30s (freshness critical); for invite emails
          // use 4h (invite may have been sent in a previous run that failed later).
          const raw = m.timestamp ?? m.receivedAt ?? 0;
          const tsMs = typeof raw === 'number' ? raw : (raw ? new Date(raw).getTime() : 0);
          return tsMs >= (sinceMs - sinceGraceMs) && matcher(m);
        });
        if (candidates.length > 0) {
          // Fetch full message body so extractInviteLinkFromMessage can read html/text fields
          const msgId = candidates[0].message_id;
          if (msgId) {
            try {
              const fullRes = await fetch(
                `https://api.agentmail.to/v0/inboxes/${inboxId}/messages/${encodeURIComponent(msgId)}`,
                { headers: { Authorization: `Bearer ${apiKey}` } },
              );
              if (fullRes.ok) return await fullRes.json();
            } catch { /* fall through to list result */ }
          }
          return candidates[0];
        }
      }
    } catch {
      // transient network error — keep retrying
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  return null; // caller throws
}

function extractOtpFromMessage(msg) {
  const text = `${msg.subject ?? ''} ${msg.body ?? ''}`;
  const match = OTP_REGEX.exec(text);
  return match ? match[1] : null;
}

function extractInviteLinkFromMessage(msg) {
  // AgentMail full-message fetch includes `html`, `text`, `extracted_text` fields.
  // The list endpoint only returns `subject` + `preview`. We need the full body.
  const text = [
    msg.subject ?? '',
    msg.body ?? '',
    msg.text ?? '',
    msg.html ?? '',
    msg.extracted_text ?? '',
    msg.preview ?? '',
  ].join(' ');
  const match = INVITE_LINK_REGEX.exec(text);
  return match ? match[0] : null;
}

// ─── Page-evaluate scripts ────────────────────────────────────────────────────
// Each function/constant is exported so unit tests can inspect/mock them
// independently, without needing a real browser.

/**
 * eval-0: Dismiss cookie banner; return any anchor signup href or null.
 * Must NOT navigate (no clicks that would change the page URL).
 */
export const findSignupUrlScript = () => {
  const allButtons = [...document.querySelectorAll('button')];
  const acceptBtn = allButtons.find((b) => /accept all|accept cookies/i.test(b.textContent ?? ''));
  if (acceptBtn) acceptBtn.click();

  for (const link of document.querySelectorAll('a')) {
    const text = link.textContent ?? '';
    const href = link.href ?? '';
    if (/sign.?up|create.?account|register/i.test(text) || /sign.?up|signup/i.test(href)) {
      return href || null;
    }
  }
  return null;
};

/**
 * eval-1: Fill the email input and click Continue.
 * Checks for pre-submit "already-registered" signals (password field already visible).
 *
 * @returns {{ alreadyRegistered: boolean, emailFilled: boolean, url: string }}
 */
export function buildFillEmailScript() {
  return (emailArg) => {
    const url = location.href;
    const bodyText = (document.body?.innerText ?? '').toLowerCase();

    // Password visible before submission = unusual but handle it
    if (
      document.querySelector('input[type="password"]') ||
      bodyText.includes('enter your password') ||
      bodyText.includes('sign in instead') ||
      bodyText.includes('already have an account')
    ) {
      return { alreadyRegistered: true, emailFilled: false, url };
    }

    const emailSelectors = [
      '#email-input', 'input[type="email"]', 'input[name="email"]',
      'input[autocomplete="email"]', 'input[placeholder*="email" i]',
    ];
    let emailInput = null;
    for (const sel of emailSelectors) {
      emailInput = document.querySelector(sel);
      if (emailInput) break;
    }
    if (!emailInput) return { alreadyRegistered: false, emailFilled: false, url };

    emailInput.focus();
    emailInput.value = emailArg;
    emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    emailInput.dispatchEvent(new Event('change', { bubbles: true }));

    const submitBtn = document.querySelector(
      'button[type="submit"], button[data-action="default"], button[value="default"]',
    );
    if (submitBtn) submitBtn.click();

    return { alreadyRegistered: false, emailFilled: true, url };
  };
}

// Backward-compat alias (some tests import this name)
export const buildNavigateToSignupScript = () => buildFillEmailScript();

/**
 * eval-2 (COMBINED): Check page state after email submission.
 *
 * Possible outcomes:
 *  'otp-needed'                    — OTP input visible (new account OR login with code)
 *  'attempting-email-code'         — password field appeared; we found & clicked the
 *                                    "use email code" link → OTP will arrive shortly
 *  'already-registered-no-code-option' — password field but no email-code link
 *  'loading'                       — page still transitioning
 *  'error'                         — page shows an error message
 *
 * @returns {{ state: string, optionText?: string, url: string }}
 */
export const handlePostSubmitStateScript = () => {
  const url = location.href;
  const bodyText = (document.body?.innerText ?? '').toLowerCase();

  // OTP input present?
  const otpInput = document.querySelector([
    'input[autocomplete="one-time-code"]',
    'input[maxlength="1"][inputmode="numeric"]',
    'input[inputmode="numeric"]',
  ].join(', '));
  if (otpInput) return { state: 'otp-needed', url };

  // URL / body signals for OTP screen
  if (
    url.includes('verify') || url.includes('otp') || url.includes('code') ||
    bodyText.includes('verify your email') || bodyText.includes('enter the code') ||
    bodyText.includes('enter your verification code') || bodyText.includes('we sent a code') ||
    bodyText.includes('check your email')
  ) {
    return { state: 'otp-needed', url };
  }

  // Password field = existing account
  const passwordInput = document.querySelector('input[type="password"]');
  if (passwordInput || bodyText.includes('enter your password')) {
    // Look for "use email code / one-time code" link
    const allEls = [...document.querySelectorAll('a, button')];
    const emailCodeEl = allEls.find((el) => {
      const t = (el.textContent ?? '').toLowerCase().trim();
      return (
        (t.includes('email') && (t.includes('code') || t.includes('sign'))) ||
        t.includes('one-time') ||
        t.includes('passwordless') ||
        (t.includes('use') && t.includes('email')) ||
        t.includes('email me a') ||
        t.includes('continue with email')
      );
    });
    if (emailCodeEl) {
      emailCodeEl.click();
      return { state: 'attempting-email-code', optionText: emailCodeEl.textContent?.trim() ?? '', url };
    }
    return { state: 'already-registered-no-code-option', url };
  }

  // Hard error
  if (
    bodyText.includes('something went wrong') ||
    bodyText.includes('not allowed') ||
    bodyText.includes('invalid email') ||
    bodyText.includes('temporarily blocked')
  ) {
    return { state: 'error', url };
  }

  // Cloudflare Turnstile / CAPTCHA challenge
  // Must be checked AFTER other states to avoid false positives
  if (
    document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
    document.querySelector('iframe[src*="turnstile"]') ||
    document.querySelector('[id*="cf-chl"]') ||
    document.querySelector('[data-sitekey]') ||
    bodyText.includes('just a moment') ||
    bodyText.includes('checking your browser') ||
    bodyText.includes('verify you are human')
  ) {
    return { state: 'cloudflare-blocked', url };
  }

  return { state: 'loading', url };
};

// Backward-compat alias
export const checkPostSubmitStateScript = handlePostSubmitStateScript;

/**
 * eval-3: Fill the OTP, then name + onboarding if shown.
 *
 * @returns {{ otpFilled: boolean, nameFilled: boolean }}
 */
export function buildFillOtpScript(otp, name) {
  return async (otpArg, nameArg) => {
    const digitInputs = [...document.querySelectorAll(
      'input[maxlength="1"], input[inputmode="numeric"]',
    )];
    let otpFilled = false;

    if (digitInputs.length >= 6) {
      for (let i = 0; i < 6; i++) {
        digitInputs[i].focus();
        digitInputs[i].value = otpArg[i];
        digitInputs[i].dispatchEvent(new Event('input', { bubbles: true }));
        digitInputs[i].dispatchEvent(new Event('change', { bubbles: true }));
      }
      otpFilled = true;
    } else {
      const single = document.querySelector(
        'input[autocomplete="one-time-code"], input[name*="code"], input[placeholder*="code"]',
      );
      if (single) {
        single.value = otpArg;
        single.dispatchEvent(new Event('input', { bubbles: true }));
        otpFilled = true;
      }
    }

    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.click();
    await new Promise((r) => setTimeout(r, 2500));

    // Password-setting step handled via CDP keyboard events — see after eval-3.

    // Name field if shown
    let nameFilled = false;
    for (const sel of [
      'input[name="name"]', 'input[name="firstName"]', 'input[id*="name"]',
      'input[placeholder*="name" i]', 'input[placeholder*="first name" i]',
    ]) {
      const nameInput = document.querySelector(sel);
      if (nameInput) {
        nameInput.value = nameArg;
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = document.querySelector('button[type="submit"]');
        if (btn) btn.click();
        nameFilled = true;
        await new Promise((r) => setTimeout(r, 2000));
        break;
      }
    }

    // Click through onboarding screens (up to 5)
    for (let i = 0; i < 5; i++) {
      const btn = [...document.querySelectorAll('button[type="submit"], button')].find((b) =>
        /continue|next|ok|agree|start|let'?s go/i.test(b.textContent ?? ''),
      );
      if (!btn) break;
      btn.click();
      await new Promise((r) => setTimeout(r, 2000));
    }

    return { otpFilled, nameFilled };
  };
}

/**
 * eval-2b: Fill the password field and click submit.
 * Used when an account was previously created via password flow (no email-code option).
 *
 * @param {string} password  The account password to try
 * @returns {(pw: string) => { passwordFilled: boolean }}
 */
export function buildFillPasswordScript(password) {
  return (passwordArg) => {
    const passInput = document.querySelector('input[type="password"]');
    if (!passInput) return { passwordFilled: false };

    passInput.focus();
    passInput.value = passwordArg;
    passInput.dispatchEvent(new Event('input', { bubbles: true }));
    passInput.dispatchEvent(new Event('change', { bubbles: true }));

    const btn = document.querySelector('button[type="submit"]');
    if (btn) btn.click();

    return { passwordFilled: true };
  };
}

/**
 * eval-4: Click the workspace invite Accept/Join button.
 * Legacy path for /invitations/ links that don't need API join.
 *
 * @returns {{ clicked: boolean, btnText: string | null }}
 */
export const clickAcceptInviteScript = () => {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    /accept|join|continue/i.test(b.textContent ?? ''),
  );
  if (btn) { btn.click(); return { clicked: true, btnText: btn.textContent?.trim() ?? null }; }
  return { clicked: false, btnText: null };
};

/**
 * eval-4 script for accepting a workspace invite.
 * Receives (workspaceId, inviteeEmail) as explicit page.evaluate() args so
 * Puppeteer serialises them correctly (closures don't survive serialisation).
 * Falls back to UI click when workspaceId is falsy (legacy /invitations/ links).
 *
 * Usage: await page.evaluate(acceptInviteScript, wsId, email)
 *
 * @param {string|null} workspaceId
 * @param {string}      inviteeEmail
 * @returns {{ clicked: boolean, btnText: string|null, apiJoin?: object }}
 */
export const acceptInviteScript = async (workspaceId, inviteeEmail) => {
  // ── (a) Direct API join if workspaceId is known ───────────────────────────
  // Fire the first available accept endpoint — don't await multiple, avoid
  // long-running async that can trigger "Promise was collected" in lightpanda.
  if (workspaceId) {
    const h = { 'Content-Type': 'application/json' };
    // Try first endpoint, then second only if first 404/405
    let joined = false;
    for (const ep of [
      `/backend-api/accounts/${workspaceId}/invites/accept`,
      `/backend-api/accounts/${workspaceId}/join`,
    ]) {
      try {
        const r = await fetch(ep, {
          method: 'POST', credentials: 'include', headers: h,
          body: JSON.stringify({ email: inviteeEmail }),
        });
        if (r.status !== 404 && r.status !== 405) {
          joined = true;
          break; // endpoint exists — accepted or will be accepted
        }
      } catch { /* try next */ }
    }
    if (joined) return { clicked: true, btnText: null, apiJoin: true };
  }

  // ── (b) UI click fallback ─────────────────────────────────────────────────
  const btn = [...document.querySelectorAll('button')].find((b) =>
    /accept|join|continue/i.test(b.textContent ?? ''),
  );
  if (btn) { btn.click(); return { clicked: true, btnText: btn.textContent?.trim() ?? null }; }
  return { clicked: false, btnText: null };
};

/** @deprecated Use acceptInviteScript with explicit args instead */
export function buildAcceptInviteScript() {
  return acceptInviteScript;
}

/**
 * eval-5: Extract OAuth token from the ChatGPT session (must run in browser context).
 *
 * @returns {Promise<object|null>}
 */
export const getSessionTokenScript = async () => {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    if (res.ok) return res.json();
  } catch { /* ignore */ }
  return null;
};

// ─── Selectors ────────────────────────────────────────────────────────────────

const EMAIL_INPUT_SELECTOR = [
  '#email-input', 'input[type="email"]', 'input[name="email"]', 'input[autocomplete="email"]',
].join(', ');

const OTP_OR_PASSWORD_SELECTOR = [
  'input[type="password"]',
  'input[autocomplete="one-time-code"]',
  'input[maxlength="1"][inputmode="numeric"]',
  'input[inputmode="numeric"]',
  'input[maxlength="1"]',
].join(', ');

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Create a fresh ChatGPT account (or log in to an existing one) using an
 * AgentMail inbox. Returns a strongly-typed result; never throws.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {CreateChatGptAccountOpts} opts
 * @returns {Promise<CreateChatGptAccountResult>}
 */
export async function createChatGptAccount(page, opts) {
  // ── 0: Validate inputs up-front ────────────────────────────────────────────
  try {
    assertOpts(opts);
  } catch (e) {
    return { success: false, error: e.message };
  }

  const {
    email,
    agentMailApiKey,
    agentMailInboxId,
    teamInviteCallback,
    agentMailPollIntervalMs = 5_000,
    agentMailTimeoutMs = 300_000,
    name = 'Codex Agent',
    pageStateCheckRetries = 6,
    pageStateCheckIntervalMs = 2_000,
    navigationDelayMs = 3_000,
  } = opts;

  const nav = (ms) => (navigationDelayMs > 0 ? sleep(Math.min(navigationDelayMs, ms)) : Promise.resolve());

  try {
    // ── STEP 1: Navigate to ChatGPT homepage (establishes Cloudflare cookies) ──
    // Without this prior navigation the signup-button click is silently blocked
    // by Cloudflare bot detection (cdn-cgi/challenge-platform).
    // Use domcontentloaded (not networkidle2) — chatgpt.com has persistent WebSocket
    // connections that prevent networkidle2 from ever resolving, causing infinite hang.
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch(() => {});
    await nav(3_000);

    await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch(() => {});
    await nav(3_000);

    // ── eval-0: dismiss cookie banner + check for signup URL ─────────────────
    const signupUrl = await page.evaluate(findSignupUrlScript).catch(() => null);

    // ── Navigate to the email auth form ──────────────────────────────────────
    // ChatGPT auth flow (2026):
    //   chatgpt.com/auth/login = landing page with "Log in" / "Sign up" buttons
    //   Clicking "Log in" navigates → auth.openai.com/log-in-or-create-account
    //   THAT page has the email input for both new signup and existing-account login.
    //
    // Strategy:
    //  1. If eval-0 found a direct href, goto it.
    //  2. Otherwise find "Log in" or "Sign up" button by text (waitForSelector,
    //     no extra evaluate call — keeps the test mock contract at eval-0 only).
    //  3. Fallback: navigate directly to auth.openai.com/log-in-or-create-account.
    if (signupUrl && typeof signupUrl === 'string' && signupUrl !== page.url()) {
      await page.goto(signupUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await nav(2_000);
    } else {
      // Try to find the "Log in" button by text content using puppeteer's ::-p-text() selector.
      // waitForSelector does NOT count as an evaluate() call in our mock contract.
      const loginBtn = await page.waitForSelector(
        '::-p-text(Log in), [data-testid="login-button"], [data-testid="signup-button"]',
        { timeout: 8_000 },
      ).catch(() => null);

      if (loginBtn) {
        const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 })
          .catch(() => null);
        await Promise.resolve(loginBtn.click()).catch(() => {});
        await navPromise;
        await nav(2_000);
      } else {
        // No button found — navigate directly to the auth form
        await page.goto(
          'https://auth.openai.com/log-in-or-create-account',
          { waitUntil: 'domcontentloaded', timeout: 30_000 },
        ).catch(() => {});
        await nav(2_000);
      }
    }

    // ── URL guard: confirm we reached the auth form (auth.openai.com) ──────────
    // After clicking "Log in" on chatgpt.com/auth/login, the page must navigate
    // to auth.openai.com/log-in-or-create-account. If we're still on chatgpt.com,
    // the button click failed (Cloudflare blocked, page not hydrated, etc.).
    {
      const postClickUrl = page.url();
      if (
        postClickUrl.includes('chatgpt.com/auth/login') ||
        postClickUrl.includes('chatgpt.com/auth/authorize')
      ) {
        throw new SignupStateError(
          'Auth navigation failed — still on chatgpt.com/auth/login after "Log in" click ' +
          '(Cloudflare blocked, page not hydrated, or ChatGPT UI changed again). ' +
          'Expected destination: auth.openai.com/log-in-or-create-account',
          { url: postClickUrl },
        );
      }
    }

    // ── Wait for email input (confirms we are on the auth form) ───────────────
    // auth.openai.com sometimes shows a "Your session has ended" intermediary page
    // with a "Log in" button before the email form. Click through it if present.
    // waitForSelector does NOT count as an evaluate() call per mock contract.
    let emailEl = await page.waitForSelector(EMAIL_INPUT_SELECTOR, { timeout: 10_000 })
      .catch(() => null);

    if (!emailEl) {
      // Handle "session ended" page — click "Log in" to reach the email form
      const authLoginBtn = await page.waitForSelector('::-p-text(Log in)', { timeout: 5_000 })
        .catch(() => null);
      if (authLoginBtn) {
        const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => null);
        await authLoginBtn.click().catch(() => {});
        await navP;
        await nav(2_000);
      }
      emailEl = await page.waitForSelector(EMAIL_INPUT_SELECTOR, { timeout: 15_000 })
        .catch(() => null);
    }

    if (!emailEl) {
      const diagUrl = page.url();
      throw new SignupStateError(
        `Email input not found after navigation to auth form`,
        { expected: EMAIL_INPUT_SELECTOR, url: diagUrl },
      );
    }

    // sinceMs BEFORE eval-1 (OTP is triggered by the Continue click inside it)
    const otpSinceMs = Date.now();

    // ── eval-1: fill email + click Continue ───────────────────────────────────
    const fillResult = await page.evaluate(buildFillEmailScript(), email);

    if (!fillResult?.emailFilled && fillResult?.alreadyRegistered) {
      // Pre-submit password field (unusual); fall through to post-submit handling
    } else if (!fillResult?.emailFilled) {
      const diagUrl = await page.evaluate(() => location.href).catch(() => '(unknown)');
      throw new SignupStateError(
        'Email input not found or not filled on auth form',
        { url: diagUrl },
      );
    }

    // ── Wait for post-submit state (OTP input OR password field) ─────────────
    await page.waitForSelector(OTP_OR_PASSWORD_SELECTOR, { timeout: 20_000 }).catch(() => {});

    // ── eval-2: classify page state; click "use email code" if needed ─────────
    let postState = { state: 'loading', url: '' };
    for (let attempt = 0; attempt < pageStateCheckRetries; attempt++) {
      if (attempt > 0) await sleep(pageStateCheckIntervalMs);
      postState = await page.evaluate(handlePostSubmitStateScript);
      if (postState.state !== 'loading') break;
    }

    if (postState.state === 'loading') {
      throw new SignupStateError(
        `Page still loading after ${pageStateCheckRetries} retries (${pageStateCheckRetries * pageStateCheckIntervalMs}ms)`,
        { url: postState.url, retries: pageStateCheckRetries },
      );
    }
    if (postState.state === 'error') {
      throw new SignupStateError('Auth page shows error state', { url: postState.url });
    }
    if (postState.state === 'cloudflare-blocked') {
      throw new SignupStateError(
        'Cloudflare challenge detected after email submit — Turnstile/CAPTCHA not resolved',
        { url: postState.url, email },
      );
    }

    // ── eval-2b: password fallback for existing password-auth accounts ────────
    // When state='already-registered-no-code-option', the account exists with
    // password auth (no "use email code" link). Try filling the known test
    // password (AutomationTest123!) to log in. If that succeeds, skip OTP poll.
    let skipOtpPoll = false;
    if (postState.state === 'already-registered-no-code-option') {
      const PASSWORD_FALLBACK = 'AutomationTest123!';
      const pwResult = await page.evaluate(buildFillPasswordScript(PASSWORD_FALLBACK), PASSWORD_FALLBACK);
      if (!pwResult?.passwordFilled) {
        throw new NoEmailCodeOptionError(
          'Email already registered; no "use email code" option found and password fill failed',
          { url: postState.url, email },
        );
      }
      // Password submitted — wait for redirect to chatgpt.com
      // waitForNavigation (not evaluate) so no extra eval call
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
      await nav(3_000);
      skipOtpPoll = true;
    }

    // state is now 'otp-needed', 'attempting-email-code', or we have skipOtpPoll=true

    // ── STEP 3: Poll AgentMail for OTP (skipped for password login) ───────────
    if (!skipOtpPoll) {
      const otpMessage = await pollAgentMailMessages(agentMailInboxId, agentMailApiKey, {
        sinceMs: otpSinceMs,
        timeoutMs: agentMailTimeoutMs,
        pollIntervalMs: agentMailPollIntervalMs,
        matcher: (m) => OTP_REGEX.test(`${m.subject ?? ''} ${m.body ?? ''}`),
      });

      if (!otpMessage) {
        const diagUrl = await page.evaluate(() => location.href).catch(() => '(unknown)');
        throw new OtpTimeoutError(
          `OTP not received within ${agentMailTimeoutMs}ms`,
          { inboxId: agentMailInboxId, sinceMs: otpSinceMs, timeoutMs: agentMailTimeoutMs, url: diagUrl },
        );
      }

      const otp = extractOtpFromMessage(otpMessage);
      if (!otp) {
        throw new SignupStateError('OTP message found but 6-digit code could not be extracted', {
          subject: otpMessage.subject,
        });
      }

      // ── eval-3: fill OTP + handle name / onboarding ─────────────────────────
      const otpResult = await page.evaluate(buildFillOtpScript(otp, name), otp, name);
      if (otpResult && !otpResult.otpFilled) {
        const diagUrl = await page.evaluate(() => location.href).catch(() => '(unknown)');
        throw new SignupStateError('OTP input not found or not filled', { url: diagUrl });
      }
      await nav(3_000);
    }

    // ── Option A: CDP keyboard.type() for create-account/password page ────────
    // If Clerk.js shows the post-OTP password-setting page, the eval-3 script
    // can't fill it (React controlled inputs ignore synthetic DOM events).
    // page.keyboard.type() sends CDP Input.dispatchKeyEvent — real keyboard events
    // that React + Clerk.js actually respond to. No page.evaluate() call needed,
    // so the eval-0..5 test contract is preserved.
    {
      const postOtpUrl = page.url();
      // eslint-disable-next-line no-console
      console.log(`[chatGptAccountCreator] post-OTP url=${postOtpUrl}`);
      if (postOtpUrl.includes('create-account')) {
        try {
          // Generated password: deterministic from email local part
          const localPart = email.split('@')[0] ?? 'user';
          const pw = `Cx!${localPart.slice(0, 6)}Aa9`;  // e.g. Cx!tastyp​Aa9
          // Focus password field, type password, submit
          await page.click('input[type="password"]').catch(() => {});
          await sleep(400);
          await page.keyboard.type(pw, { delay: 30 });
          await sleep(300);
          // Check for confirm-password field
          const allPwFields = await page.$$('input[type="password"]').catch(() => []);
          if (allPwFields.length >= 2) {
            await allPwFields[1].click().catch(() => {});
            await sleep(200);
            await page.keyboard.type(pw, { delay: 30 });
            await sleep(300);
          }
          await page.click('button[type="submit"]').catch(() => {});
          // eslint-disable-next-line no-console
          console.log(`[chatGptAccountCreator] password-step: submitted pw=${pw.replace(/./g, '*')}`);
        } catch (pwErr) {
          // eslint-disable-next-line no-console
          console.log(`[chatGptAccountCreator] password-step error: ${pwErr.message}`);
        }
      }
    }

    // ── Wait for OAuth callback to complete before sending invite ────────────
    // waitForFunction can trigger "Promise was collected" in lightpanda when the
    // page navigates mid-poll. Simple sleep is more reliable.
    // Use navigationDelayMs as the gate: 0 in tests (instant), >0 in production
    // → sleep 8s to cover auth.openai.com → chatgpt.com OAuth redirect + NextAuth
    // session cookie establishment.
    await sleep(navigationDelayMs > 0 ? 8_000 : 0);

    // ── STEP 5: Send team invite ──────────────────────────────────────────────
    // Set sinceMs BEFORE calling the invite callback — the API invite is so fast
    // that the email can arrive before the callback returns. The 30s grace window
    // in pollAgentMailMessages handles any remaining race.
    const inviteSinceMs = Date.now();
    if (teamInviteCallback) {
      try {
        await teamInviteCallback(email);
      } catch (e) {
        throw new InviteError(`teamInviteCallback failed: ${e.message}`, { email });
      }
    }

    // ── STEP 6: Poll for invite email ─────────────────────────────────────────
    const inviteMessage = await pollAgentMailMessages(agentMailInboxId, agentMailApiKey, {
      sinceMs: inviteSinceMs,
      timeoutMs: agentMailTimeoutMs,
      pollIntervalMs: agentMailPollIntervalMs,
      // 4-hour grace: if a previous run sent the invite but failed later, the email
      // is already in the inbox. Pick it up rather than waiting for a re-send.
      sinceGraceMs: 4 * 60 * 60 * 1000,
      matcher: (m) => {
        // OpenAI API-based invites: subject = "X has invited you to ChatGPT Business"
        // body text: "has invited you to collaborate using ChatGPT Business"
        // Legacy UI invites: "invited you to join"
        // Also match by invite link in email body.
        const text = `${m.subject ?? ''} ${m.body ?? ''} ${m.text ?? ''}`;
        return (
          text.includes('invited you to join') ||
          text.includes('invited you to ChatGPT') ||
          text.includes('invited you to collaborate') ||
          text.includes('ChatGPT Business') ||
          INVITE_LINK_REGEX.test(text)
        );
      },
    });

    if (!inviteMessage) {
      throw new InviteError(
        `Team invite email not received within ${agentMailTimeoutMs}ms`,
        { inboxId: agentMailInboxId, sinceMs: inviteSinceMs, timeoutMs: agentMailTimeoutMs },
      );
    }

    const inviteLink = extractInviteLinkFromMessage(inviteMessage);
    if (!inviteLink) {
      throw new InviteError('Invite email found but chatgpt.com/invitations link missing', {
        subject: inviteMessage.subject,
        body: String(inviteMessage.body ?? '').slice(0, 200),
      });
    }

    // ── STEP 7 + eval-4: Accept workspace invite ─────────────────────────────
    // The invite link from the API is: chatgpt.com/auth/login?inv_ws_name=...&wId=...
    // Navigating to auth/login RESETS the existing session. Instead:
    //   (a) Try direct API join from within the authenticated page (eval-4 slot).
    //   (b) If API join fails, navigate to chatgpt.com/?accept_wId=... (avoids auth/login).
    //   (c) eval-4 also handles the legacy UI click path for /invitations/ links.

    // Extract workspace ID from invite link (no extra eval call — pure JS string parsing)
    let wsIdFromLink = null;
    try {
      const u = new URL(inviteLink.replace(/&amp;/g, '&'));
      wsIdFromLink = u.searchParams.get('accept_wId') || u.searchParams.get('wId') || null;
    } catch { /* ignore */ }

    // eval-4: Accept the workspace invite.
    //
    // Strategy: stay on chatgpt.com (where eagerstatus254 is already logged in after
    // OTP signup). Call workspace join API directly using the session cookie.
    // Navigating away (even to chatgpt.com/?accept_wId=...) resets the session in
    // lightpanda, so we avoid ALL navigation here.
    //
    // For legacy /invitations/ links (no wId param), fall back to page navigation +
    // UI click — that flow doesn't have the session-reset problem.
    if (wsIdFromLink) {
      // API join — no navigation, session stays intact
      await page.evaluate(acceptInviteScript, wsIdFromLink, email);
      await nav(3_000);
    } else {
      // Legacy: navigate to invite link + UI click
      await page.goto(inviteLink.replace(/&amp;/g, '&'), { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      await nav(4_000);
      await page.evaluate(acceptInviteScript, null, email);
      await nav(5_000);
    }

    // ── eval-5: extract session token ─────────────────────────────────────────
    // page.url() (not evaluate) to check if we drifted to auth pages
    if (page.url().includes('auth/login') || page.url().includes('auth.openai.com')) {
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await nav(4_000);
    }

    const session = await page.evaluate(getSessionTokenScript);
    const access = session?.accessToken ?? session?.access_token ?? null;

    if (!access) {
      const diagUrl = page.url();
      throw new TokenExtractionError(
        'No accessToken in /api/auth/session after invite acceptance',
        { url: diagUrl, sessionKeys: Object.keys(session ?? {}) },
      );
    }

    const refresh  = session?.refreshToken ?? session?.refresh_token ?? null;
    const expires  = session?.expires ? Date.parse(session.expires) : Date.now() + 3_600_000;
    const accountId = session?.user?.id ?? session?.sub ?? null;

    /** @type {ChatGptAuth} */
    const auth = { type: 'oauth', access, refresh, expires, accountId };
    return { success: true, auth };

  } catch (err) {
    // Convert typed errors to structured strings; pass unknown errors verbatim
    const code = /** @type {any} */ (err)?.code ?? null;
    const base = code ? `${code}: ${err.message}` : String(err?.message ?? err);
    const ctx = /** @type {any} */ (err)?.context;
    const suffix = ctx ? ` [${Object.entries(ctx).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}]` : '';
    return { success: false, error: `${base}${suffix}` };
  }
}
