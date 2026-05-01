import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createChatGptAccount } from '../../../src/pipeline/rotation/chatGptAccountCreator.js';

// Save/restore global fetch
let savedFetch;
beforeEach(() => { savedFetch = global.fetch; });
afterEach(() => { global.fetch = savedFetch; jest.restoreAllMocks(); });

// ─── evaluate() call sequence ────────────────────────────────────────────────
//
//  eval-0  findSignupUrlScript          → null | string
//  eval-1  buildFillEmailScript()       → { emailFilled, alreadyRegistered, url }
//  eval-2  handlePostSubmitStateScript  → { state, optionText?, url }
//            state: 'otp-needed' | 'attempting-email-code' |
//                   'already-registered-no-code-option' | 'loading' | 'error'
//  eval-3  buildFillOtpScript(otp,name) → { otpFilled, nameFilled }
//  eval-4  clickAcceptInviteScript      → { clicked, btnText }
//  eval-5  getSessionTokenScript        → session object
//
// Both the "new account" path and the "existing account email-code login" path
// share this same 6-call contract.  The difference is eval-2:
//   New account:   state='otp-needed'
//   Existing acct: state='attempting-email-code' (password field found, code link clicked)

// ─── Mock page factory ────────────────────────────────────────────────────────
/**
 * Build a mock page where evaluate() calls are dispatched by call-count.
 * The optional `pageOverrides` object lets tests replace specific methods.
 */
function mockPage(handlers, pageOverrides = {}) {
  let callIndex = 0;
  return {
    goto:             jest.fn().mockResolvedValue({}),
    evaluate:         jest.fn().mockImplementation(async (fn, ...args) => {
      const handler = handlers[callIndex] ?? (() => ({}));
      callIndex++;
      return handler(fn, ...args);
    }),
    waitForSelector:  jest.fn().mockResolvedValue({ click: jest.fn() }),
    click:            jest.fn().mockResolvedValue({}),
    type:             jest.fn().mockResolvedValue({}),
    $:                jest.fn().mockResolvedValue(null),
    $$:               jest.fn().mockResolvedValue([]),
    url:              jest.fn().mockReturnValue('https://chatgpt.com/'),
    waitForNavigation: jest.fn().mockResolvedValue({}),
    waitForFunction:   jest.fn().mockResolvedValue({}),
    keyboard: { press: jest.fn().mockResolvedValue({}) },
    ...pageOverrides,
  };
}

// ─── Pre-built evaluate handlers ─────────────────────────────────────────────
const E_FIND_SIGNUP_URL   = () => null;                                      // eval-0
const E_SIGNUP_OK         = () => ({ alreadyRegistered: false, emailFilled: true,  url: 'https://auth.openai.com/' }); // eval-1
const E_ALREADY_REG_PRE   = () => ({ alreadyRegistered: true,  emailFilled: false, url: 'https://chatgpt.com/' });    // eval-1 (pre-submit detect)
const E_OTP_NEEDED        = () => ({ state: 'otp-needed',          url: 'https://auth.openai.com/verify' }); // eval-2 new acct
const E_ATTEMPTING_EMAIL_CODE = () => ({ state: 'attempting-email-code', optionText: 'Use email code', url: 'https://auth.openai.com/login' }); // eval-2 existing acct
const E_NO_CODE_OPTION    = () => ({ state: 'already-registered-no-code-option', url: 'https://auth.openai.com/login' }); // eval-2 no option
const E_CLOUDFLARE_BLOCKED = () => ({ state: 'cloudflare-blocked', url: 'https://auth.openai.com/log-in-or-create-account' }); // eval-2 turnstile
const E_FILL_PASSWORD_OK  = () => ({ passwordFilled: true });  // eval-2b password login succeeds
const E_FILL_PASSWORD_FAIL = () => ({ passwordFilled: false }); // eval-2b password fill fails
const E_FILL_OTP_OK       = () => ({ otpFilled: true,  nameFilled: false }); // eval-3
const E_ACCEPT_OK         = () => ({ clicked: true,    btnText: 'Accept' }); // eval-4
const E_SESSION = (access = 'access_xyz', userId = 'user_abc', expiresOffset = 3_600_000) =>
  () => ({ accessToken: access, user: { id: userId }, expires: new Date(Date.now() + expiresOffset).toISOString() });
const E_NO_SESSION        = () => ({});                                      // eval-5 → token-extraction-failed

// ─── AgentMail fetch helpers ──────────────────────────────────────────────────
function makeOtpMessage(otp = '123456') {
  return { subject: 'Verify your email', body: `Your code: ${otp}`, receivedAt: Date.now() };
}
function makeInviteMessage(link = 'https://chatgpt.com/invitations/abc123') {
  return { subject: 'You were invited', body: `invited you to join ${link}`, receivedAt: Date.now() };
}
function mockFetchSequence(otp = '123456', inviteLink = 'https://chatgpt.com/invitations/abc123') {
  let call = 0;
  global.fetch = jest.fn().mockImplementation(async () => {
    call++;
    if (call === 1) return { ok: true, json: async () => ({ messages: [makeOtpMessage(otp)] }) };
    return { ok: true, json: async () => ({ messages: [makeInviteMessage(inviteLink)] }) };
  });
}
function mockFetchEmpty() {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) });
}

// ─── Base test options ────────────────────────────────────────────────────────
const BASE_OPTS = {
  email:                   'test@agentmail.to',
  agentMailApiKey:         'am_testkey123',
  agentMailInboxId:        'test@agentmail.to',
  agentMailPollIntervalMs: 5,
  agentMailTimeoutMs:      300,
  pageStateCheckRetries:   1,
  pageStateCheckIntervalMs: 5,
  navigationDelayMs:       0,
};

// ─────────────────────────── Input validation ─────────────────────────────────
describe('input validation', () => {
  test('returns error when email is missing', async () => {
    const page = mockPage([]);
    const result = await createChatGptAccount(page, { ...BASE_OPTS, email: '' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/email/i);
  });

  test('returns error when agentMailApiKey is too short', async () => {
    const page = mockPage([]);
    const result = await createChatGptAccount(page, { ...BASE_OPTS, agentMailApiKey: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/agentMailApiKey/i);
  });
});

// ─────────────────────────── TC-4: already registered ────────────────────────
describe('TC-4: email already registered with ChatGPT', () => {
  // Pre-submit detection (password visible before filling the form — unusual edge case)
  test('pre-submit: alreadyRegistered=true → attempts email-code login → succeeds', async () => {
    // eval-1 returns alreadyRegistered=true (pre-submit password field)
    // eval-2 finds and clicks the email-code option → state='attempting-email-code'
    // Then OTP flow proceeds normally
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_ALREADY_REG_PRE,        // eval-1: alreadyRegistered=true
      E_ATTEMPTING_EMAIL_CODE,   // eval-2: clicks "use email code" link
      E_FILL_OTP_OK,
      E_ACCEPT_OK,
      E_SESSION(),
    ]);
    mockFetchSequence();
    const teamInviteCallback = jest.fn().mockResolvedValue({});

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback });
    expect(result.success).toBe(true);
    expect(result.auth?.access).toBe('access_xyz');
    expect(teamInviteCallback).toHaveBeenCalledWith(BASE_OPTS.email);
  });

  // Post-submit detection: password field appeared → email code link clicked → success
  test('post-submit: state=attempting-email-code → login succeeds', async () => {
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,               // eval-1: email filled, Continue clicked
      E_ATTEMPTING_EMAIL_CODE,   // eval-2: password appeared, code link clicked
      E_FILL_OTP_OK,
      E_ACCEPT_OK,
      E_SESSION(),
    ]);
    mockFetchSequence();
    const teamInviteCallback = jest.fn().mockResolvedValue({});

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback });
    expect(result.success).toBe(true);
    expect(result.auth?.type).toBe('oauth');
    expect(teamInviteCallback).toHaveBeenCalled();
  });

  // No email-code option AND password fill fails → NO_EMAIL_CODE_OPTION error
  test('post-submit: state=already-registered-no-code-option + password fill fails → returns no-email-code-option error', async () => {
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,
      E_NO_CODE_OPTION,           // eval-2: password field, no code link
      E_FILL_PASSWORD_FAIL,       // eval-2b: no password input found
    ]);
    mockFetchEmpty();
    const teamInviteCallback = jest.fn();

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/NO_EMAIL_CODE_OPTION/);
    expect(teamInviteCallback).not.toHaveBeenCalled();
  });

  // Password login fallback: no email code link but password fills OK → invite flow completes
  test('post-submit: state=already-registered-no-code-option + password login → invite flow succeeds', async () => {
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,
      E_NO_CODE_OPTION,           // eval-2: no email code link
      E_FILL_PASSWORD_OK,         // eval-2b: password filled + submit clicked
      // No OTP step — skipped for password login
      E_ACCEPT_OK,                // eval-4 (now at index 4): click Accept invite
      E_SESSION(),                // eval-5 (now at index 5): extract session
    ]);
    // Only invite poll (no OTP poll)
    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCall++;
      return { ok: true, json: async () => ({ messages: [makeInviteMessage()] }) };
    });
    const teamInviteCallback = jest.fn().mockResolvedValue({});

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback });
    expect(result.success).toBe(true);
    expect(result.auth?.access).toBe('access_xyz');
    expect(teamInviteCallback).toHaveBeenCalledWith(BASE_OPTS.email);
    // Only one fetch poll (invite); OTP poll was skipped
    expect(fetchCall).toBe(1);
  });

  // email-input-not-found via waitForSelector returning null
  test('email-input-not-found when waitForSelector returns null', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL], {
      waitForSelector: jest.fn().mockResolvedValue(null),
    });

    const result = await createChatGptAccount(page, { ...BASE_OPTS });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SIGNUP_STATE_ERROR|email.?input/i);
    // eval-1 (fillEmail) was not called — only eval-0 + the diagnostic URL evaluate
    expect(page.evaluate.mock.calls.length).toBeLessThanOrEqual(2);
  });

  // email-input-not-found from eval-1
  test('email-input-not-found from eval-1 when DOM has no email input', async () => {
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      () => ({ alreadyRegistered: false, emailFilled: false, url: 'https://error.com' }),
    ]);

    const result = await createChatGptAccount(page, { ...BASE_OPTS });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SIGNUP_STATE_ERROR|email/i);
  });
});

// ─────────────────────────── Cloudflare detection ────────────────────────────
describe('Cloudflare Turnstile detection', () => {
  test('state=cloudflare-blocked after email submit → SIGNUP_STATE_ERROR with cloudflare in message', async () => {
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,
      E_CLOUDFLARE_BLOCKED,  // eval-2: turnstile detected
    ]);
    mockFetchEmpty();

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback: jest.fn() });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SIGNUP_STATE_ERROR/);
    expect(result.error.toLowerCase()).toMatch(/cloudflare/);
  });
});

// ─────────────────────────── Signup navigation guard ─────────────────────────
describe('URL guard after signup button click', () => {
  test('page.url() still chatgpt.com/auth/login after signup click → SIGNUP_STATE_ERROR immediately (not email-fill)', async () => {
    // Simulate: button click happened but navigation never occurred
    // chatgpt.com/auth/login ALSO has an email input (login form) — waitForSelector would find it
    // Without URL guard, code would fill the wrong form and produce "Page still loading" error
    // With URL guard, code throws immediately with clear "navigation failed" message
    const page = mockPage([
      E_FIND_SIGNUP_URL,  // eval-0: no signup href found
      // eval-1 and beyond should NEVER be called because URL guard fires first
    ], {
      url: jest.fn().mockReturnValue('https://chatgpt.com/auth/login'),
      // email input IS found on chatgpt.com/auth/login (login form) — the trap
      waitForSelector: jest.fn().mockResolvedValue({ click: jest.fn() }),
    });
    mockFetchEmpty();

    const result = await createChatGptAccount(page, { ...BASE_OPTS });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SIGNUP_STATE_ERROR/);
    expect(result.error.toLowerCase()).toMatch(/navigation failed|still on chatgpt/);
    // Only eval-0 (findSignupUrl) was called — guard fired before eval-1 (fillEmail)
    expect(page.evaluate.mock.calls.length).toBe(1);
  });

  test('page.url() on auth.openai.com after signup click → proceeds normally', async () => {
    // Normal case: navigation succeeded — URL changed to auth.openai.com
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,
      E_OTP_NEEDED,
      E_FILL_OTP_OK,
      E_ACCEPT_OK,
      E_SESSION(),
    ], {
      url: jest.fn().mockReturnValue('https://auth.openai.com/log-in-or-create-account'),
    });
    mockFetchSequence();

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback: jest.fn().mockResolvedValue({}) });
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────── TC-6: OTP timeout ───────────────────────────────
describe('TC-6: OTP never arrives', () => {
  test('returns OTP_TIMEOUT error when AgentMail returns no messages', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED]);
    mockFetchEmpty();

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      agentMailTimeoutMs: 50,
      teamInviteCallback: jest.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/OTP_TIMEOUT/);
  });
});

// ─────────────────────────── TC-9: invite timeout ────────────────────────────
describe('TC-9: invite email never arrives', () => {
  test('returns INVITE_ERROR when invite never comes after OTP succeeds', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK]);

    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCall++;
      if (fetchCall === 1) return { ok: true, json: async () => ({ messages: [makeOtpMessage()] }) };
      return { ok: true, json: async () => ({ messages: [] }) };
    });

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      agentMailTimeoutMs: 100,
      teamInviteCallback: jest.fn().mockResolvedValue({}),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/INVITE_ERROR/);
  });
});

// ─────────────────────────── TC-3: successful full flow ──────────────────────
describe('TC-3: successful account creation', () => {
  test('happy path — new account (otp-needed) through all 6 eval calls', async () => {
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,
      E_OTP_NEEDED,
      E_FILL_OTP_OK,
      E_ACCEPT_OK,
      E_SESSION(),
    ]);
    mockFetchSequence('654321');
    const teamInviteCallback = jest.fn().mockResolvedValue({});

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback });

    expect(result.success).toBe(true);
    expect(result.auth?.type).toBe('oauth');
    expect(result.auth?.access).toBe('access_xyz');
    expect(result.auth?.accountId).toBe('user_abc');
    expect(result.auth?.expires).toBeGreaterThan(Date.now());
    expect(teamInviteCallback).toHaveBeenCalledWith(BASE_OPTS.email);
  });

  test('happy path — existing account (attempting-email-code) through all 6 eval calls', async () => {
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,
      E_ATTEMPTING_EMAIL_CODE,  // password field; code link clicked
      E_FILL_OTP_OK,
      E_ACCEPT_OK,
      E_SESSION(),
    ]);
    mockFetchSequence();
    const teamInviteCallback = jest.fn().mockResolvedValue({});

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback });

    expect(result.success).toBe(true);
    expect(result.auth?.access).toBe('access_xyz');
  });

  test('page.goto is called for chatgpt.com/ first, then /auth/login', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK, E_ACCEPT_OK, E_SESSION()]);
    mockFetchSequence();

    await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback: jest.fn() });

    const gotoUrls = page.goto.mock.calls.map((c) => c[0]);
    expect(gotoUrls[0]).toBe('https://chatgpt.com/');
    expect(gotoUrls[1]).toBe('https://chatgpt.com/auth/login');
  });

  test('goto is called for the invite link', async () => {
    const inviteUrl = 'https://chatgpt.com/invitations/testlink99';
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK, E_ACCEPT_OK, E_SESSION()]);
    mockFetchSequence('654321', inviteUrl);

    await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback: jest.fn() });

    expect(page.goto.mock.calls.map((c) => c[0])).toContain(inviteUrl);
  });
});

// ─────────────────────────── token extraction ─────────────────────────────────
describe('token extraction', () => {
  test('returns TOKEN_EXTRACTION_ERROR when session has no accessToken', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK, E_ACCEPT_OK, E_NO_SESSION]);
    mockFetchSequence();

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      teamInviteCallback: jest.fn().mockResolvedValue({}),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/TOKEN_EXTRACTION_ERROR/);
  });
});

// ─────────────────────────── sinceMs filtering ────────────────────────────────
describe('sinceMs filtering', () => {
  test('stale OTP (receivedAt=0) is rejected by sinceMs filter → OTP_TIMEOUT', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED]);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ subject: 'Verify', body: '111222', receivedAt: 0 }] }),
    });

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      agentMailTimeoutMs: 100,
      teamInviteCallback: jest.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/OTP_TIMEOUT/);
  });

  test('sinceMs is captured BEFORE eval-1 (before Continue click triggers OTP)', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK, E_ACCEPT_OK, E_SESSION()]);
    const beforeCreate = Date.now();

    let firstFetchTime = null;
    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCall++;
      if (fetchCall === 1) { firstFetchTime = Date.now(); return { ok: true, json: async () => ({ messages: [makeOtpMessage()] }) }; }
      return { ok: true, json: async () => ({ messages: [makeInviteMessage()] }) };
    });

    const result = await createChatGptAccount(page, { ...BASE_OPTS, teamInviteCallback: jest.fn().mockResolvedValue({}) });

    expect(result.success).toBe(true);
    // OTP was fetched after sinceMs (which was captured after beforeCreate)
    expect(firstFetchTime).toBeGreaterThanOrEqual(beforeCreate);
  });
});

// ─────────────────────────── post-submit state retries ────────────────────────
describe('post-submit state check', () => {
  test('retries when state=loading, succeeds on second attempt', async () => {
    let stateCall = 0;
    const stateHandler = () => {
      stateCall++;
      return stateCall === 1
        ? { state: 'loading', url: 'https://chatgpt.com/' }
        : { state: 'otp-needed', url: 'https://chatgpt.com/auth/verify' };
    };

    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,
      stateHandler,  // first: loading
      stateHandler,  // second: otp-needed
      E_FILL_OTP_OK,
      E_ACCEPT_OK,
      E_SESSION(),
    ]);
    mockFetchSequence();

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      pageStateCheckRetries: 3,
      teamInviteCallback: jest.fn().mockResolvedValue({}),
    });

    expect(result.success).toBe(true);
    expect(stateCall).toBe(2);
  });

  test('returns SIGNUP_STATE_ERROR when still loading after all retries', async () => {
    const page = mockPage([
      E_FIND_SIGNUP_URL,
      E_SIGNUP_OK,
      () => ({ state: 'loading', url: 'https://chatgpt.com/' }),
      () => ({ state: 'loading', url: 'https://chatgpt.com/' }),
    ]);
    mockFetchEmpty();

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      pageStateCheckRetries: 2,
      teamInviteCallback: jest.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SIGNUP_STATE_ERROR/);
    expect(result.error).toMatch(/loading/);
  });
});

// ─────────────────────────── fetch errors ─────────────────────────────────────
describe('agentmail fetch errors', () => {
  test('continues polling after network error, eventually OTP_TIMEOUT', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED]);
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    const result = await createChatGptAccount(page, {
      ...BASE_OPTS,
      agentMailTimeoutMs: 80,
      teamInviteCallback: jest.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/OTP_TIMEOUT/);
  });
});

// ─────────────────────────── teamInviteCallback optional ──────────────────────
describe('teamInviteCallback is optional', () => {
  test('proceeds to invite poll even without callback (invite pre-existing)', async () => {
    const page = mockPage([E_FIND_SIGNUP_URL, E_SIGNUP_OK, E_OTP_NEEDED, E_FILL_OTP_OK, E_ACCEPT_OK, E_SESSION()]);
    mockFetchSequence();

    const result = await createChatGptAccount(page, { ...BASE_OPTS });

    expect(result.success).toBe(true);
    expect(result.auth?.access).toBe('access_xyz');
  });
});
