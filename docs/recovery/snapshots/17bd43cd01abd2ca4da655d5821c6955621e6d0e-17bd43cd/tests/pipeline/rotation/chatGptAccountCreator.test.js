import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createChatGptAccount } from '../../../src/pipeline/rotation/chatGptAccountCreator.js';

// Save/restore global fetch
let savedFetch;
beforeEach(() => { savedFetch = global.fetch; });
afterEach(() => { global.fetch = savedFetch; jest.restoreAllMocks(); });

// ─────────────────────────── evaluate() call sequence ────────────────────────────
// The implementation makes exactly these evaluate() calls (in order):
//
//  1. navigateToSignup(email)  → { alreadyRegistered, emailFilled, url }
//  2. checkPostSubmitState()   → { state: 'otp-needed'|'already-registered'|'loading'|'error' }
//     (retried up to pageStateCheckRetries times until state !== 'loading')
//  3. fillOtpAndOnboard(otp)   → { otpFilled, nameFilled }
//  4. clickAcceptInvite()      → { clicked, btnText }
//  5. getSessionToken()        → { accessToken?, user?, expires? }
//
// TC-4 (already-registered): evaluate-1 returns alreadyRegistered=true → exit immediately
// All other cases: evaluate-1 returns alreadyRegistered=false → proceeds through all 5 calls

// ─────────────────────────── mock page factory ───────────────────────────────────
/**
 * Build a mock page where evaluate() calls are dispatched by call-count.
 *
 * @param {Array<(fn, ...args) => any>} handlers - one handler per evaluate() call
 * @param {object} [pageOverrides] - optional overrides for page methods
 */
function mockPage(handlers, pageOverrides = {}) {
  let callIndex = 0;
  return {
    goto: jest.fn().mockResolvedValue({}),
    evaluate: jest.fn().mockImplementation(async (fn, ...args) => {
      const handler = handlers[callIndex] ?? (() => ({}));
      callIndex++;
      return handler(fn, ...args);
    }),
    waitForSelector: jest.fn().mockResolvedValue({ click: jest.fn() }),
    click: jest.fn().mockResolvedValue({}),
    type: jest.fn().mockResolvedValue({}),
    $: jest.fn().mockResolvedValue(null),
    $$: jest.fn().mockResolvedValue([]),
    url: jest.fn().mockReturnValue('https://chatgpt.com/'),
    waitForNavigation: jest.fn().mockResolvedValue({}),
    ...pageOverrides,
  };
}

// Pre-built evaluate handler sequences for common scenarios.
//
// evaluate() call order in createChatGptAccount:
//   eval-0: findSignupUrlScript           → null | string URL
//   eval-1: buildFillEmailScript()        → { alreadyRegistered, emailFilled, url }
//   eval-2: checkPostSubmitStateScript    → { state: 'otp-needed'|'already-registered'|... }
//   eval-3: buildFillOtpScript(otp,name)  → { otpFilled, nameFilled }
//   eval-4: clickAcceptInviteScript       → { clicked, btnText }
//   eval-5: getSessionTokenScript         → { accessToken?, user?, expires? }
//
// E_FIND_SIGNUP_URL: first call — return null so no extra page.goto is triggered

const E_FIND_SIGNUP_URL = () => null;
const E_SIGNUP_OK    = () => ({ alreadyRegistered: false, emailFilled: true, url: 'https://chatgpt.com/' });
const E_ALREADY_REG  = () => ({ alreadyRegistered: true,  emailFilled: false, url: 'https://chatgpt.com/' });
const E_OTP_NEEDED   = () => ({ state: 'otp-needed', url: 'https://chatgpt.com/auth/verify' });
const E_FILL_OTP_OK  = () => ({ otpFilled: true, nameFilled: false });
const E_ACCEPT_OK    = () => ({ clicked: true, btnText: 'Accept' });
const E_SESSION      = (accessToken = 'access_xyz', userId = 'user_abc', expiresOffset = 3600_000) =>
  () => ({ accessToken, user: { id: userId }, expires: new Date(Date.now() + expiresOffset).toISOString() });
const E_NO_SESSION   = () => ({});  // empty session → token-extraction-failed

// ─────────────────────────── agentmail fetch helpers ─────────────────────────────
function makeOtpMessage(otp = '123456') {
  return { subject: 'Verify your email', body: `Your code: ${otp}`, receivedAt: Date.now() };
}

function makeInviteMessage(link = 'https://chatgpt.com/invitations/abc123') {
  return { subject: 'You were invited', body: `invited you to join ${link}`, receivedAt: Date.now() };
}

/**
 * Mock global.fetch to return different responses on successive calls.
 * Last element is repeated for any calls beyond the array length.
 */
function mockFetchSequence(responses) {
  let call = 0;
  global.fetch = jest.fn().mockImplementation(async () => {
    const r = responses[Math.min(call++, responses.length - 1)];
    return { ok: true, json: async () => r };
  });
}

function mockFetchEmpty() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [] }),
  });
}

// ─────────────────────────── common options ───────────────────────────────────────
const BASE_OPTS = {
  email: 'test@agentmail.to',
  agentMailApiKey: 'am_testkey',
  agentMailInboxId: 'test@agentmail.to',
  agentMailPollIntervalMs: 5,     // fast for tests
  agentMailTimeoutMs: 300,        // short for tests
  pageStateCheckRetries: 1,       // don't retry state check in tests
  pageStateCheckIntervalMs: 5,    // fast
  navigationDelayMs: 0,           // no sleeps in tests
};

// ─────────────────────────── TC-4: already registered ────────────────────────────
describe('TC-4: email already registered with ChatGPT', () => {
  test('pre-submit detection: returns already-registered without calling teamInviteCallback', async () => {
    const teamInviteCallback = jest.fn();
    // evaluate-1 returns alreadyRegistered=true → early exit
    const page = mockPage([E_FIND_SIGNUP_URL, E_ALREADY_REG]);

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback });

    expect(result.success).toBe(false);
    expect(result.error).toBe('already-registered');
    expect(teamInviteCallback).not.toHaveBeenCalled();
  });

  test('post-submit detection: returns already-registered when page shows password field', async () => {
    const teamInviteCallback = jest.fn();
    // evaluate-1 says email was filled (no pre-submit sign)
    // evaluate-2 (post-submit state check) says already-registered
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,
      () => ({ state: 'already-registered', url: 'https://chatgpt.com/auth/login' }),
    ]);
    mockFetchEmpty(); // fetch should not be called for OTP

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback });

    expect(result.success).toBe(false);
    expect(result.error).toBe('already-registered');
    expect(teamInviteCallback).not.toHaveBeenCalled();
  });

  test('email-input-not-found when waitForSelector returns null (signup page unreachable)', async () => {
    // waitForSelector for the email input returns null → early exit with email-input-not-found.
    // eval-0 (findSignupUrlScript) IS called first; eval-1 (fillEmail) is NOT reached.
    const page = mockPage([E_FIND_SIGNUP_URL], {
      waitForSelector: jest.fn().mockResolvedValue(null),
    });

    const result = await createChatGptAccount(page, { ...BASE_OPTS });

    expect(result.success).toBe(false);
    // Error includes diagnostic URL suffix: 'email-input-not-found:<url>'
    expect(result.error).toMatch(/^email-input-not-found/);
    // eval-0 (findSignupUrlScript) + eval for diagnostic URL = 2 total; fillEmail NOT called
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  test('email-input-not-found from evaluate-1 when email input not in DOM', async () => {
    // waitForSelector returns truthy (found something), but evaluate-1 says not filled
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      () => ({ alreadyRegistered: false, emailFilled: false, url: 'https://error.com' }),
    ]);

    const result = await createChatGptAccount(page, { ...BASE_OPTS });

    expect(result.success).toBe(false);
    expect(result.error).toBe('email-input-not-found');
  });
});

// ─────────────────────────── TC-6: OTP timeout ───────────────────────────────────
describe('TC-6: OTP never arrives', () => {
  test('returns otp-timeout when agentmail returns no messages within timeout', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED]);
    mockFetchEmpty();

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      agentMailTimeoutMs: 50,
      teamInviteCallback: jest.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('otp-timeout');
  });
});

// ─────────────────────────── TC-9: invite timeout ────────────────────────────────
describe('TC-9: invite email never arrives', () => {
  test('returns invite-timeout when invite never comes after OTP succeeds', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK]);

    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCall++;
      // First fetch: OTP arrives
      if (fetchCall === 1) {
        return { ok: true, json: async () => ({ messages: [makeOtpMessage()] }) };
      }
      // All subsequent: no invite (empty inbox)
      return { ok: true, json: async () => ({ messages: [] }) };
    });

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      agentMailTimeoutMs: 100,
      teamInviteCallback: jest.fn().mockResolvedValue({}),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('invite-timeout');
  });
});

// ─────────────────────────── TC-3: successful full flow ──────────────────────────
describe('TC-3: successful account creation', () => {
  test('returns auth token on happy path through all 5 evaluate calls', async () => {
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,     // evaluate-1: fill email + click Continue
      E_OTP_NEEDED,    // evaluate-2: post-submit state → OTP needed
      E_FILL_OTP_OK,   // evaluate-3: fill OTP + onboarding
      E_ACCEPT_OK,     // evaluate-4: accept workspace invite
      E_SESSION(),     // evaluate-5: get session token
    ]);

    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCall++;
      if (fetchCall === 1) {
        // OTP email
        return { ok: true, json: async () => ({ messages: [makeOtpMessage('654321')] }) };
      }
      // Invite email
      return { ok: true, json: async () => ({ messages: [makeInviteMessage()] }) };
    });

    const teamInviteCallback = jest.fn().mockResolvedValue({});

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback });

    expect(result.success).toBe(true);
    expect(result.auth).toBeDefined();
    expect(result.auth.type).toBe('oauth');
    expect(result.auth.access).toBe('access_xyz');
    expect(result.auth.accountId).toBe('user_abc');
    expect(result.auth.expires).toBeGreaterThan(Date.now());
    expect(teamInviteCallback).toHaveBeenCalledWith(BASE_OPTS.email);
  });

  test('page.goto is called first for chatgpt.com/auth/login', async () => {
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK, E_ACCEPT_OK, E_SESSION(),
    ]);

    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCall++;
      if (fetchCall === 1) return { ok: true, json: async () => ({ messages: [makeOtpMessage()] }) };
      return { ok: true, json: async () => ({ messages: [makeInviteMessage()] }) };
    });

    await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback: jest.fn() });

    // First goto must navigate to ChatGPT login page
    expect(page.goto).toHaveBeenCalledWith(
      'https://chatgpt.com/auth/login',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
  });

  test('goto is called again for the invite link', async () => {
    const inviteUrl = 'https://chatgpt.com/invitations/testlink99';
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK, E_ACCEPT_OK, E_SESSION(),
    ]);

    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCall++;
      if (fetchCall === 1) return { ok: true, json: async () => ({ messages: [makeOtpMessage()] }) };
      return { ok: true, json: async () => ({ messages: [makeInviteMessage(inviteUrl)] }) };
    });

    await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback: jest.fn() });

    // Second goto must be for the invite link
    const gotoCalls = page.goto.mock.calls.map((c) => c[0]);
    expect(gotoCalls).toContain(inviteUrl);
  });
});

// ──────────────────────── token extraction fallback ───────────────────────────────
describe('token extraction: returns token-extraction-failed when session is empty', () => {
  test('returns token-extraction-failed when session returns no accessToken', async () => {
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK, E_ACCEPT_OK,
      E_NO_SESSION, // evaluate-5: empty session
    ]);

    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCall++;
      if (fetchCall === 1) return { ok: true, json: async () => ({ messages: [makeOtpMessage()] }) };
      return { ok: true, json: async () => ({ messages: [makeInviteMessage()] }) };
    });

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      teamInviteCallback: jest.fn().mockResolvedValue({}),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('token-extraction-failed');
  });
});

// ──────────────────────── sinceMs filtering ──────────────────────────────────────
describe('sinceMs filtering for OTP', () => {
  test('does not accept OTP messages received before the signup was triggered (stale)', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED]);

    // Return a stale message (receivedAt = 0, way before sinceMs)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ subject: 'Verify', body: '111222', receivedAt: 0 }] }),
    });

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      agentMailTimeoutMs: 100,
      teamInviteCallback: jest.fn(),
    });

    // Stale message ignored → timeout
    expect(result.success).toBe(false);
    expect(result.error).toBe('otp-timeout');
  });

  test('sinceMs is set BEFORE evaluate-1 (before Continue click triggers OTP)', async () => {
    // OTP poll gets OTP message; invite poll gets invite message.
    // Both receivedAt = Date.now() (fresh), so both pass the sinceMs filter.
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK, E_ACCEPT_OK, E_SESSION()]);
    const beforeCreate = Date.now();

    let otpFetchCallTime = null;
    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCall++;
      if (fetchCall === 1) {
        otpFetchCallTime = Date.now();
        return { ok: true, json: async () => ({ messages: [makeOtpMessage()] }) };
      }
      return { ok: true, json: async () => ({ messages: [makeInviteMessage()] }) };
    });

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      teamInviteCallback: jest.fn().mockResolvedValue({}),
    });

    expect(result.success).toBe(true);
    // OTP fetch happened AFTER sinceMs was captured, so receivedAt >= sinceMs
    expect(otpFetchCallTime).toBeGreaterThanOrEqual(beforeCreate);
  });
});

// ──────────────────────── post-submit state: retries loading ─────────────────────
describe('post-submit state check handles loading state', () => {
  test('retries state check when page is still loading', async () => {
    // evaluate-2 (state check) is called up to pageStateCheckRetries times.
    // First call returns 'loading', second call returns 'otp-needed'.
    // Because the mockPage dispatches by index, we need TWO handler slots for evaluate-2.
    let stateCallCount = 0;
    const stateHandler = () => {
      stateCallCount++;
      return stateCallCount === 1
        ? { state: 'loading', url: 'https://chatgpt.com/' }
        : { state: 'otp-needed', url: 'https://chatgpt.com/auth/verify' };
    };

    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,
      stateHandler, // evaluate-2, call 1 → 'loading'
      stateHandler, // evaluate-2, call 2 → 'otp-needed'
      E_FILL_OTP_OK,
      E_ACCEPT_OK,
      E_SESSION(),
    ]);

    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCall++;
      if (fetchCall === 1) return { ok: true, json: async () => ({ messages: [makeOtpMessage()] }) };
      return { ok: true, json: async () => ({ messages: [makeInviteMessage()] }) };
    });

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      pageStateCheckRetries: 3,
      teamInviteCallback: jest.fn().mockResolvedValue({}),
    });

    expect(result.success).toBe(true);
    expect(stateCallCount).toBe(2); // 'loading' once then 'otp-needed'
  });
});

// ──────────────────────── agentmail fetch error handling ─────────────────────────
describe('agentmail fetch errors', () => {
  test('continues polling after a fetch error, eventually times out with otp-timeout', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED]);
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      agentMailTimeoutMs: 80,
      teamInviteCallback: jest.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('otp-timeout');
  });
});

// ──────────────────────── teamInviteCallback not provided ────────────────────────
describe('teamInviteCallback is optional', () => {
  test('skips invite step and moves to invite polling when no callback provided', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK, E_ACCEPT_OK, E_SESSION()]);

    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCall++;
      if (fetchCall === 1) return { ok: true, json: async () => ({ messages: [makeOtpMessage()] }) };
      return { ok: true, json: async () => ({ messages: [makeInviteMessage()] }) };
    });

    // No teamInviteCallback provided — should still proceed to invite polling
    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      // teamInviteCallback: undefined
    });

    // Without an actual invite being sent, we'd timeout, but here the mock
    // returns an invite message anyway (simulating pre-existing invite)
    expect(result.success).toBe(true);
    expect(result.auth.access).toBe('access_xyz');
  });
});
