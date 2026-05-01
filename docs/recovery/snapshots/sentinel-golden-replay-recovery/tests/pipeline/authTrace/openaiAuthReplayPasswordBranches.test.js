import { describe, expect, test } from '@jest/globals';

import { replayOpenAiAuthFlow } from '../../../src/pipeline/authTrace/openaiAuthReplay.js';

function makePasswordBootstrapFetch({ sessionEmail = 'member@example.com' } = {}) {
  return async (url, options = {}) => {
    if (url === 'https://chatgpt.com/auth/login_with') {
      return {
        status: 200,
        headers: new Headers({
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': '__Host-next-auth.csrf-token=csrf-value%7Chash; Path=/; HttpOnly; Secure; SameSite=Lax, __Secure-next-auth.callback-url=https%3A%2F%2Fchatgpt.com%2Fauth%2Flogin_with; Path=/; HttpOnly; Secure; SameSite=Lax',
        }),
        text: async () => '<html>login_with</html>',
      };
    }
    if (url === 'https://chatgpt.com/api/auth/providers') {
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"openai":{}}' };
    }
    if (url === 'https://chatgpt.com/api/auth/csrf') {
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"csrfToken":"csrf-value"}' };
    }
    if (url === 'https://chatgpt.com/api/auth/signin/openai?prompt=login') {
      return {
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
          'set-cookie': '__Secure-next-auth.state=state-cookie; Path=/; HttpOnly; Secure; SameSite=Lax',
        }),
        text: async () => '{"url":"https://auth.openai.com/api/accounts/authorize?client_id=app_123&state=state-123&screen_hint=login&prompt=login"}',
      };
    }
    if (url.startsWith('https://auth.openai.com/api/accounts/authorize?')) {
      return {
        status: 302,
        headers: new Headers({
          location: 'https://auth.openai.com/log-in/password',
          'set-cookie': 'login_session=session-123; Domain=auth.openai.com; Path=/; HttpOnly; Secure; SameSite=Lax',
        }),
        text: async () => '',
      };
    }
    if (url === 'https://auth.openai.com/log-in/password') {
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: async () => '<html>password login</html>',
      };
    }
    if (url === 'https://chatgpt.com/api/auth/callback/openai?code=code-123&state=state-123') {
      expect(options.headers.cookie).toContain('__Secure-next-auth.state=state-cookie');
      return {
        status: 302,
        headers: new Headers({
          location: 'https://chatgpt.com/auth/login_with',
          'set-cookie': '__Secure-next-auth.session-token=session-token-123; Path=/; Domain=.chatgpt.com; HttpOnly; Secure; SameSite=Lax',
        }),
        text: async () => '',
      };
    }
    if (url === 'https://chatgpt.com/api/auth/session') {
      expect(options.headers.cookie).toContain('__Secure-next-auth.session-token=session-token-123');
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
        text: async () => JSON.stringify({
          user: { id: 'user-123', email: sessionEmail },
          expires: '2026-03-17T00:00:00.000Z',
          account: { id: 'acct-123' },
          accessToken: 'access-123',
          authProvider: 'openai',
        }),
      };
    }

    throw new Error(`Unexpected URL ${url}`);
  };
}

describe('replayOpenAiAuthFlow password branches', () => {
  test('authorizing to /log-in/password can complete the browserless password-login branch', async () => {
    const result = await replayOpenAiAuthFlow({
      email: 'member@example.com',
      mode: 'password-login',
      fetchImpl: makePasswordBootstrapFetch(),
      submitPasswordLogin: async ({ email, password, redirectLocation }) => {
        expect(email).toBe('member@example.com');
        expect(password).toBe('secret-password');
        expect(redirectLocation).toBe('https://auth.openai.com/log-in/password');
        return {
          step: {
            name: 'submit_password_login',
            url: 'https://auth.openai.com/api/accounts/password/login',
            method: 'POST',
            requestedAt: '2026-03-16T20:00:00.000Z',
            elapsedMs: 0,
            status: 200,
            requestHeaders: { 'content-type': 'application/json' },
            requestBody: '{"username":"member@example.com"}',
            responseHeaders: { location: null, 'set-cookie': null, 'content-type': 'application/json' },
            responseJson: { continue_url: 'https://chatgpt.com/api/auth/callback/openai?code=code-123&state=state-123' },
            responseTextPreview: '{}',
          },
          responseJson: { continue_url: 'https://chatgpt.com/api/auth/callback/openai?code=code-123&state=state-123' },
        };
      },
      password: 'secret-password',
      now: () => new Date('2026-03-16T20:00:00.000Z'),
    });

    expect(result.branch).toBe('password-login');
    expect(result.verdict).toBe('authenticated');
    expect(result.steps.map((step) => step.name)).toEqual([
      'bootstrap_login_with',
      'bootstrap_providers',
      'bootstrap_csrf',
      'bootstrap_signin_openai',
      'authorize_with_login_hint',
      'load_password_login',
      'submit_password_login',
      'chatgpt_callback',
      'chatgpt_callback_redirect',
      'chatgpt_session',
    ]);
  });

  test('forgot-password branch can initiate reset, consume reset email, complete reset, and authenticate', async () => {
    const result = await replayOpenAiAuthFlow({
      email: 'member@example.com',
      mode: 'forgot-password',
      fetchImpl: makePasswordBootstrapFetch(),
      submitPasswordLogin: async () => ({
        step: {
          name: 'submit_password_login',
          url: 'https://auth.openai.com/api/accounts/password/login',
          method: 'POST',
          requestedAt: '2026-03-16T20:00:00.000Z',
          elapsedMs: 0,
          status: 401,
          requestHeaders: { 'content-type': 'application/json' },
          requestBody: '{}',
          responseHeaders: { location: null, 'set-cookie': null, 'content-type': 'application/json' },
          responseJson: { error: 'invalid_credentials', next: 'forgot-password' },
          responseTextPreview: '{}',
        },
        responseJson: { error: 'invalid_credentials', next: 'forgot-password' },
      }),
      initiateForgotPassword: async ({ email, redirectLocation }) => {
        expect(email).toBe('member@example.com');
        expect(redirectLocation).toBe('https://auth.openai.com/log-in/password');
        return {
          step: {
            name: 'initiate_forgot_password',
            url: 'https://auth.openai.com/api/accounts/forgot-password',
            method: 'POST',
            requestedAt: '2026-03-16T20:00:00.000Z',
            elapsedMs: 0,
            status: 200,
            requestHeaders: { 'content-type': 'application/json' },
            requestBody: '{}',
            responseHeaders: { location: null, 'set-cookie': null, 'content-type': 'application/json' },
            responseJson: { reset_requested: true },
            responseTextPreview: '{}',
          },
          responseJson: { reset_requested: true },
        };
      },
      consumeResetEmail: async ({ email }) => {
        expect(email).toBe('member@example.com');
        return {
          step: {
            name: 'consume_reset_email',
            url: 'https://auth.openai.com/reset-password?ticket=ticket-123',
            method: 'GET',
            requestedAt: '2026-03-16T20:00:00.000Z',
            elapsedMs: 0,
            status: 200,
            requestHeaders: {},
            requestBody: null,
            responseHeaders: { location: null, 'set-cookie': null, 'content-type': 'text/html' },
            responseJson: null,
            responseTextPreview: '<html>reset password</html>',
          },
          resetUrl: 'https://auth.openai.com/reset-password?ticket=ticket-123',
        };
      },
      completeForgotPassword: async ({ email, resetUrl, newPassword }) => {
        expect(email).toBe('member@example.com');
        expect(resetUrl).toBe('https://auth.openai.com/reset-password?ticket=ticket-123');
        expect(newPassword).toBe('reset-password');
        return {
          step: {
            name: 'complete_forgot_password',
            url: 'https://auth.openai.com/api/accounts/reset-password',
            method: 'POST',
            requestedAt: '2026-03-16T20:00:00.000Z',
            elapsedMs: 0,
            status: 200,
            requestHeaders: { 'content-type': 'application/json' },
            requestBody: '{}',
            responseHeaders: { location: null, 'set-cookie': null, 'content-type': 'application/json' },
            responseJson: { continue_url: 'https://chatgpt.com/api/auth/callback/openai?code=code-123&state=state-123' },
            responseTextPreview: '{}',
          },
          responseJson: { continue_url: 'https://chatgpt.com/api/auth/callback/openai?code=code-123&state=state-123' },
        };
      },
      password: 'reset-password',
      now: () => new Date('2026-03-16T20:00:00.000Z'),
    });

    expect(result.branch).toBe('forgot-password');
    expect(result.verdict).toBe('authenticated');
    expect(result.steps.map((step) => step.name)).toEqual([
      'bootstrap_login_with',
      'bootstrap_providers',
      'bootstrap_csrf',
      'bootstrap_signin_openai',
      'authorize_with_login_hint',
      'load_password_login',
      'submit_password_login',
      'initiate_forgot_password',
      'consume_reset_email',
      'complete_forgot_password',
      'chatgpt_callback',
      'chatgpt_callback_redirect',
      'chatgpt_session',
    ]);
  });

  test('unsupported password flow returns a typed blocker instead of silently falling through', async () => {
    const result = await replayOpenAiAuthFlow({
      email: 'member@example.com',
      mode: 'password-login',
      fetchImpl: makePasswordBootstrapFetch(),
      now: () => new Date('2026-03-16T20:00:00.000Z'),
    });

    expect(result.branch).toBe('password-login');
    expect(result.verdict).toBe('blocked');
    expect(result.blockerReason).toBe('password-login-unsupported');
    expect(result.steps.map((step) => step.name)).toContain('load_password_login');
  });
});
