/**
 * chatGptAccountCreator.js
 *
 * Creates a fresh ChatGPT account using an AgentMail inbox email address.
 *
 * All ChatGPT DOM interactions use page.evaluate() (browser context).
 * AgentMail polling uses Node.js fetch (server-side API, no Cloudflare protection).
 *
 * EACH STEP VALIDATES ITS RESULT BEFORE PROCEEDING — failures surface
 * a descriptive error immediately rather than timing out silently.
 *
 * Key invariants from spec:
 *  - sinceMs set BEFORE triggering OTP send (prevents stale OTP acceptance)
 *  - Invite email polling uses separate sinceMs after invite is triggered
 *  - Returns { success: false, error } on any failure — never throws
 *
 * evaluate() call sequence (tests rely on this order):
 *  1. navigateToSignup(email)   → { alreadyRegistered, emailFilled, url }
 *  2. checkPostSubmitState()    → { state: 'otp-needed'|'already-registered'|'error' }
 *  3. fillOtpAndOnboard(otp)    → void
 *  4. clickAcceptInvite()       → void
 *  5. getSessionToken()         → { accessToken?, refreshToken?, user?, expires? }
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OTP_REGEX = /\b(\d{6})\b/;
const INVITE_LINK_REGEX = /https:\/\/chatgpt\.com\/invitations\/[^\s"'<>]+/;

// ── AgentMail polling ─────────────────────────────────────────────────────────────

/**
 * Poll AgentMail inbox for a message matching `matcher`.
 * Only considers messages with receivedAt >= sinceMs.
 */
async function pollAgentMailMessages(inboxId, apiKey, {
  sinceMs = 0,
  timeoutMs = 300_000,
  pollIntervalMs = 5_000,
  matcher = () => true,
} = {}) {
  const url = `https://api.agentmail.to/v0/inboxes/${inboxId}/messages?limit=20`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        const messages = (data.messages ?? []).filter(
          (m) => (m.receivedAt ?? 0) >= sinceMs && matcher(m),
        );
        if (messages.length > 0) return messages[0];
      }
    } catch {
      // Network error — keep retrying until timeout
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return null;
}

function extractOtp(message) {
  const text = `${message.subject ?? ''} ${message.body ?? ''}`;
  const match = OTP_REGEX.exec(text);
  return match ? match[1] : null;
}

function extractInviteLink(message) {
  const text = `${message.subject ?? ''} ${message.body ?? ''}`;
  const match = INVITE_LINK_REGEX.exec(text);
  return match ? match[0] : null;
}

// ── evaluate() step implementations ──────────────────────────────────────────────
// Each exported-for-test function below corresponds to one page.evaluate() call.
// IMPORTANT: evaluate() calls must NOT trigger cross-page navigation (i.e. clicking
// links that cause full-page navigations). Navigation is handled outside evaluate()
// via page.goto() / page.waitForNavigation().

/**
 * Prepare the current page for signup navigation:
 *  1. Dismiss any cookie consent banner (side-effect, safe to repeat)
 *  2. Return the signup URL if an anchor link is present (for use with page.goto)
 *     OR return null if navigation must be done via button click (handled outside).
 *
 * Called via page.evaluate() — must NOT cause page navigation itself.
 * Tests mock this to return null (triggering the button-click code path).
 */
export const findSignupUrlScript = () => {
  // Dismiss cookie / consent banner if present
  const allButtons = [...document.querySelectorAll('button')];
  const acceptBtn = allButtons.find((b) => /accept all|accept cookies/i.test(b.textContent ?? ''));
  if (acceptBtn) acceptBtn.click();

  // Look for an anchor link to the signup page
  const links = [...document.querySelectorAll('a')];
  for (const link of links) {
    const text = link.textContent ?? '';
    const href = link.href ?? '';
    if (/sign.?up|create.?account|register/i.test(text) || /sign.?up|signup/i.test(href)) {
      return href || null;
    }
  }
  // Auth0 "Don't have an account? Sign up" link
  const auth0Signup = document.querySelector('[name="screen_hint"][value="signup"]');
  if (auth0Signup) return location.href;
  return null;
};

/**
 * evaluate-step-1: Fill the email input and click Continue.
 * Assumes the browser is already on the signup/auth form page (page.goto has
 * already been called by the outer function to get here).
 * Also performs a pre-submit check for "already registered" indicators.
 *
 * Returns: { alreadyRegistered: boolean, emailFilled: boolean, url: string }
 */
export function buildFillEmailScript() {
  return (emailArg) => {
    const bodyText = (document.body?.innerText ?? '').toLowerCase();
    const url = location.href;

    // Pre-submit already-registered indicators on the form page
    const preAlreadyRegistered =
      document.querySelector('input[type="password"]') !== null ||
      bodyText.includes('sign in instead') ||
      bodyText.includes('already have an account') ||
      bodyText.includes('enter your password');

    if (preAlreadyRegistered) {
      return { alreadyRegistered: true, emailFilled: false, url };
    }

    // Fill the email input
    const emailSelectors = [
      '#email-input',
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="email" i]',
    ];
    let emailInput = null;
    for (const sel of emailSelectors) {
      emailInput = document.querySelector(sel);
      if (emailInput) break;
    }

    if (!emailInput) {
      return { alreadyRegistered: false, emailFilled: false, url };
    }

    emailInput.focus();
    emailInput.value = emailArg;
    emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    emailInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Click the Continue / Submit button
    const submitBtn = document.querySelector(
      'button[type="submit"], button[data-action="default"], button[value="default"]',
    );
    if (submitBtn) submitBtn.click();

    return { alreadyRegistered: false, emailFilled: true, url };
  };
}

// Backward compat alias (tests reference buildNavigateToSignupScript in some places)
export const buildNavigateToSignupScript = () => buildFillEmailScript();

/**
 * evaluate-step-2: Check page state after the email was submitted.
 * Detects whether ChatGPT is asking for an OTP (new account) or a password
 * (existing account = already-registered).
 *
 * Returns: { state: 'otp-needed' | 'already-registered' | 'loading' | 'error', url }
 */
export const checkPostSubmitStateScript = () => {
  const bodyText = (document.body?.innerText ?? '').toLowerCase();
  const url = location.href;

  // Password input = existing account → already-registered
  if (document.querySelector('input[type="password"]')) {
    return { state: 'already-registered', url };
  }
  if (
    bodyText.includes('sign in instead') ||
    bodyText.includes('enter your password') ||
    bodyText.includes('wrong email or password')
  ) {
    return { state: 'already-registered', url };
  }

  // OTP / verification code input = new account → proceed
  const otpInput = document.querySelector(
    'input[autocomplete="one-time-code"], input[maxlength="1"], input[inputmode="numeric"]',
  );
  if (otpInput) return { state: 'otp-needed', url };

  if (
    url.includes('verify') ||
    url.includes('code') ||
    url.includes('otp') ||
    bodyText.includes('verify your email') ||
    bodyText.includes('enter your verification code') ||
    bodyText.includes('enter the code') ||
    bodyText.includes('we sent a code')
  ) {
    return { state: 'otp-needed', url };
  }

  if (bodyText.includes('error') || bodyText.includes('invalid') || bodyText.includes('not allowed')) {
    return { state: 'error', url };
  }

  return { state: 'loading', url };
};

/**
 * evaluate-step-3: Fill the OTP code, then fill name/onboarding fields if shown.
 * Handles both multi-box (6 × 1-char inputs) and single-input OTP layouts.
 *
 * Returns: { otpFilled: boolean, nameFilled: boolean }
 */
export function buildFillOtpScript(otp, name) {
  return async (otpArg, nameArg) => {
    // Fill multi-digit OTP
    const digitInputs = [
      ...document.querySelectorAll('input[maxlength="1"], input[inputmode="numeric"]'),
    ];
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
        single.dispatchEvent(new Event('change', { bubbles: true }));
        otpFilled = true;
      }
    }

    // Submit the OTP if there's a submit button
    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.click();

    // Wait for page transition
    await new Promise((r) => setTimeout(r, 2500));

    // Fill name if prompted
    let nameFilled = false;
    const nameSelectors = [
      'input[name="name"]',
      'input[name="firstName"]',
      'input[id*="name"]',
      'input[placeholder*="name" i]',
      'input[placeholder*="your name" i]',
      'input[placeholder*="first name" i]',
    ];
    let nameInput = null;
    for (const sel of nameSelectors) {
      nameInput = document.querySelector(sel);
      if (nameInput) break;
    }
    if (nameInput) {
      nameInput.value = nameArg;
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = document.querySelector('button[type="submit"]');
      if (btn) btn.click();
      nameFilled = true;
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Click through any remaining onboarding screens (up to 5 times)
    for (let i = 0; i < 5; i++) {
      const continueButtons = [...document.querySelectorAll(
        'button[type="submit"], button[data-action], button',
      )];
      const continueBtn = continueButtons.find((b) =>
        /continue|next|ok|agree|start|let'?s go/i.test(b.textContent ?? ''),
      );
      if (!continueBtn) break;
      continueBtn.click();
      await new Promise((r) => setTimeout(r, 2000));
    }

    return { otpFilled, nameFilled };
  };
}

/**
 * evaluate-step-4: Click the "Accept" / "Join" button on the workspace invite page.
 *
 * Returns: { clicked: boolean, btnText: string | null }
 */
export const clickAcceptInviteScript = () => {
  const buttons = [...document.querySelectorAll('button')];
  const acceptBtn = buttons.find((b) =>
    /accept|join|continue/i.test(b.textContent ?? ''),
  );
  if (acceptBtn) {
    acceptBtn.click();
    return { clicked: true, btnText: acceptBtn.textContent?.trim() ?? null };
  }
  return { clicked: false, btnText: null };
};

/**
 * evaluate-step-5: Extract the OAuth token from the ChatGPT session endpoint.
 * Must run from within the browser context so cookies are included automatically.
 *
 * Returns: session object or null
 */
export const getSessionTokenScript = async () => {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    if (res.ok) return res.json();
  } catch {
    // ignore
  }
  return null;
};

// ── Main export ───────────────────────────────────────────────────────────────────

/**
 * Create a fresh ChatGPT account using a clean AgentMail inbox.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {object} opts
 * @param {string}   opts.email                  - AgentMail inbox address
 * @param {string}   opts.agentMailApiKey         - Root mailbox API key for polling
 * @param {string}   opts.agentMailInboxId        - AgentMail inbox ID
 * @param {Function} [opts.teamInviteCallback]    - async (email) => void
 * @param {number}   [opts.agentMailPollIntervalMs=5000]
 * @param {number}   [opts.agentMailTimeoutMs=300000]
 * @param {string}   [opts.name='Codex Agent']
 * @param {number}   [opts.pageStateCheckRetries=6]   - how many times to retry post-submit state check
 * @param {number}   [opts.pageStateCheckIntervalMs=2000]
 *
 * @returns {Promise<
 *   { success: true, auth: { type: 'oauth', access: string, refresh: string|null, expires: number, accountId: string|null } }
 *   | { success: false, error: string }
 * >}
 */
export async function createChatGptAccount(page, {
  email,
  agentMailApiKey,
  agentMailInboxId,
  teamInviteCallback,
  agentMailPollIntervalMs = 5_000,
  agentMailTimeoutMs = 300_000,
  name = 'Codex Agent',
  pageStateCheckRetries = 6,
  pageStateCheckIntervalMs = 2_000,
  // navigationDelayMs: delay after each page.goto() to allow JS to settle.
  // Set to 0 in tests (fast), production default 3000ms.
  navigationDelayMs = 3_000,
}) {
  const EMAIL_INPUT_SELECTOR = '#email-input, input[type="email"], input[name="email"], input[autocomplete="email"]';
  const OTP_OR_PASSWORD_SELECTOR = [
    'input[type="password"]',
    'input[autocomplete="one-time-code"]',
    'input[maxlength="1"][inputmode="numeric"]',
    'input[inputmode="numeric"]',
    'input[maxlength="1"]',
  ].join(', ');

  try {
    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 1 — NAVIGATION (outside evaluate, so context is never destroyed):
    //   1a. Go to ChatGPT login page
    //   1b. Find the signup URL from the landing page (evaluate — pure read, no nav)
    //   1c. page.goto(signupUrl) to reach the auth form
    //   1d. waitForSelector for the email input (confirms we're on the right page)
    // ─────────────────────────────────────────────────────────────────────────────
    // Step 1a: Load chatgpt.com homepage to establish Cloudflare session cookies.
    //          Without this, clicks on chatgpt.com/auth/login are silently blocked by
    //          Cloudflare bot detection (cdn-cgi/challenge-platform).
    await page.goto('https://chatgpt.com/', {
      waitUntil: 'networkidle2',
      timeout: 60_000,
    }).catch(() => {});

    if (navigationDelayMs > 0) await sleep(navigationDelayMs);

    // Step 1b: Navigate to the login/signup landing page
    await page.goto('https://chatgpt.com/auth/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    }).catch(() => {});

    if (navigationDelayMs > 0) await sleep(navigationDelayMs);

    // eval-0: dismiss cookie banner + find signup anchor URL (pure read, no navigation)
    const signupUrl = await page.evaluate(findSignupUrlScript).catch(() => null);

    if (signupUrl && typeof signupUrl === 'string' && signupUrl !== page.url()) {
      // Direct anchor link found — navigate to it
      await page.goto(signupUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      if (navigationDelayMs > 0) await sleep(navigationDelayMs);
    } else {
      // chatgpt.com renders a JS button (data-testid="signup-button") that navigates
      // to auth.openai.com/log-in-or-create-account. We must race click+navigation.
      const signupNavPromise = page.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(() => null);

      await Promise.resolve(page.click('[data-testid="signup-button"]')).catch(() => {});
      await signupNavPromise;
      if (navigationDelayMs > 0) await sleep(Math.min(navigationDelayMs, 2_000));
    }

    // Wait for the email input to appear on auth.openai.com
    const emailEl = await page.waitForSelector(EMAIL_INPUT_SELECTOR, { timeout: 25_000 }).catch(() => null);
    if (!emailEl) {
      const diagUrl = await page.evaluate(() => location.href).catch(() => '(unknown)');
      return { success: false, error: `email-input-not-found:${diagUrl}` };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 2 — FILL EMAIL:
    //   sinceMs set BEFORE clicking Continue (OTP is sent when Continue is clicked)
    // ─────────────────────────────────────────────────────────────────────────────

    // otpSinceMs MUST be set before the Continue click triggers the OTP email
    const otpSinceMs = Date.now();

    // evaluate-1: fill email + click Continue + pre-submit already-registered check
    const signupResult = await page.evaluate(buildFillEmailScript(), email);

    if (signupResult?.alreadyRegistered) {
      return { success: false, error: 'already-registered' };
    }

    if (!signupResult?.emailFilled) {
      return { success: false, error: 'email-input-not-found' };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 3 — VALIDATE POST-SUBMIT PAGE STATE:
    //   Wait for the OTP input or password input to appear (outside evaluate).
    //   Then check: OTP input = new account, password = already-registered.
    // ─────────────────────────────────────────────────────────────────────────────
    await page.waitForSelector(OTP_OR_PASSWORD_SELECTOR, { timeout: 20_000 }).catch(() => {});

    let postSubmitState = { state: 'loading', url: '' };
    for (let attempt = 0; attempt < pageStateCheckRetries; attempt++) {
      await sleep(pageStateCheckIntervalMs);
      // evaluate-2: check page state
      postSubmitState = await page.evaluate(checkPostSubmitStateScript);
      if (postSubmitState.state !== 'loading') break;
    }

    if (postSubmitState.state === 'already-registered') {
      return { success: false, error: 'already-registered' };
    }

    if (postSubmitState.state === 'error') {
      return { success: false, error: `signup-page-error:${postSubmitState.url}` };
    }

    // state === 'otp-needed' OR 'loading' (optimistic: proceed to OTP poll)

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 3: Poll AgentMail for the OTP verification email.
    //         sinceMs was captured in Step 1 (before email was submitted).
    // ─────────────────────────────────────────────────────────────────────────────
    const otpMessage = await pollAgentMailMessages(agentMailInboxId, agentMailApiKey, {
      sinceMs: otpSinceMs,
      timeoutMs: agentMailTimeoutMs,
      pollIntervalMs: agentMailPollIntervalMs,
      matcher: (m) => OTP_REGEX.test(`${m.subject ?? ''} ${m.body ?? ''}`),
    });

    if (!otpMessage) {
      return { success: false, error: 'otp-timeout' };
    }

    const otp = extractOtp(otpMessage);
    if (!otp) {
      return { success: false, error: 'otp-extraction-failed' };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 4 (evaluate-3): Fill OTP, fill name if shown, click through onboarding.
    // ─────────────────────────────────────────────────────────────────────────────
    const otpResult = await page.evaluate(buildFillOtpScript(otp, name), otp, name);

    if (otpResult && !otpResult.otpFilled) {
      return { success: false, error: 'otp-input-not-found' };
    }

    if (navigationDelayMs > 0) await sleep(navigationDelayMs);

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 5: Trigger the ChatGPT team invite (owner sends invite to this email).
    // ─────────────────────────────────────────────────────────────────────────────
    if (teamInviteCallback) {
      await teamInviteCallback(email);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 6: Poll AgentMail for the team invite email.
    //         inviteSinceMs is set AFTER the invite was triggered.
    // ─────────────────────────────────────────────────────────────────────────────
    const inviteSinceMs = Date.now();
    const inviteMessage = await pollAgentMailMessages(agentMailInboxId, agentMailApiKey, {
      sinceMs: inviteSinceMs,
      timeoutMs: agentMailTimeoutMs,
      pollIntervalMs: agentMailPollIntervalMs,
      matcher: (m) => {
        const text = `${m.subject ?? ''} ${m.body ?? ''}`;
        return text.includes('invited you to join') || INVITE_LINK_REGEX.test(text);
      },
    });

    if (!inviteMessage) {
      return { success: false, error: 'invite-timeout' };
    }

    const inviteLink = extractInviteLink(inviteMessage);
    if (!inviteLink) {
      return { success: false, error: 'invite-link-extraction-failed' };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 7: Navigate to the invite link, accept the workspace.
    // ─────────────────────────────────────────────────────────────────────────────
    await page.goto(inviteLink, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    }).catch(() => {/* best-effort */});

    if (navigationDelayMs > 0) await sleep(Math.min(navigationDelayMs, 4_000));

    // evaluate-4: click the Accept / Join button
    const acceptResult = await page.evaluate(clickAcceptInviteScript);

    if (navigationDelayMs > 0) await sleep(Math.min(navigationDelayMs, 5_000));

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 8 (evaluate-5): Extract OAuth token from the now-authenticated session.
    // ─────────────────────────────────────────────────────────────────────────────
    const session = await page.evaluate(getSessionTokenScript);

    // Validate: token must have an accessToken
    const access = session?.accessToken ?? session?.access_token ?? null;
    if (!access) {
      return { success: false, error: 'token-extraction-failed' };
    }

    const refresh = session?.refreshToken ?? session?.refresh_token ?? null;
    const expires = session?.expires
      ? Date.parse(session.expires)
      : Date.now() + 3_600_000;
    const accountId = session?.user?.id ?? session?.sub ?? null;

    return {
      success: true,
      auth: { type: 'oauth', access, refresh, expires, accountId },
    };
  } catch (e) {
    return { success: false, error: String(e?.message ?? e) };
  }
}
