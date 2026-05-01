import { describe, expect, test } from '@jest/globals';

import { replayOpenAiAuthFlow } from '../../../src/pipeline/authTrace/openaiAuthReplay.js';

describe('replayOpenAiAuthFlow', () => {
  test('runs a browserless existing-account OTP login from blank bootstrap to authenticated ChatGPT session', async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });

      if (url === 'https://chatgpt.com/auth/login_with') {
        return {
          status: 200,
          headers: new Headers({
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': [
              '__Host-next-auth.csrf-token=csrf-value%7Chash; Path=/; HttpOnly; Secure; SameSite=Lax',
              '__Secure-next-auth.callback-url=https%3A%2F%2Fchatgpt.com%2Fauth%2Flogin_with; Path=/; HttpOnly; Secure; SameSite=Lax',
            ].join(', '),
          }),
          text: async () => '<html>login_with</html>',
        };
      }

      if (url === 'https://chatgpt.com/api/auth/providers') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
          text: async () => '{"openai":{}}',
        };
      }

      if (url === 'https://chatgpt.com/api/auth/csrf') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
          text: async () => '{"csrfToken":"csrf-value"}',
        };
      }

      if (url === 'https://chatgpt.com/api/auth/signin/openai?prompt=login') {
        return {
          status: 200,
          headers: new Headers({
            'content-type': 'application/json; charset=utf-8',
            'set-cookie': '__Secure-next-auth.state=state-cookie; Path=/; HttpOnly; Secure; SameSite=Lax',
            'openai-processing-ms': '321',
            'x-request-id': 'req-signin-123',
          }),
          text: async () => '{"url":"https://auth.openai.com/api/accounts/authorize?client_id=app_X8zY6vW2pQ9tR3dE7nK1jL5gH&state=state-123&screen_hint=login&prompt=login"}',
        };
      }

      if (url.startsWith('https://auth.openai.com/api/accounts/authorize?')) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get('screen_hint')).toBe('login_or_signup');
        expect(parsed.searchParams.get('login_hint')).toBe('test.user@agentmail.to');
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/email-verification',
            'set-cookie': [
              'login_session=session-123; Domain=auth.openai.com; Path=/; HttpOnly; Secure; SameSite=Lax',
              'hydra_redirect=redirect-123; Domain=auth.openai.com; Path=/; HttpOnly; Secure; SameSite=Lax',
            ].join(', '),
          }),
          text: async () => '',
        };
      }

      if (url === 'https://auth.openai.com/email-verification') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          text: async () => '<html>email verification</html>',
        };
      }

      if (url === 'https://auth.openai.com/api/accounts/email-otp/validate') {
        expect(options.method).toBe('POST');
        expect(options.headers.cookie).toContain('login_session=session-123');
        expect(options.body).toBe('{"code":"123456"}');
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
          text: async () => '{"continue_url":"https://chatgpt.com/api/auth/callback/openai?code=code-123&state=state-123","method":"GET","page":{"type":"external_url"}}',
        };
      }

      if (url === 'https://chatgpt.com/api/auth/callback/openai?code=code-123&state=state-123') {
        expect(options.headers.cookie).toContain('__Secure-next-auth.state=state-cookie');
        return {
          status: 302,
          headers: new Headers({
            location: 'https://chatgpt.com/auth/login_with',
            'set-cookie': [
              '__Secure-next-auth.session-token=session-token-123; Path=/; Domain=.chatgpt.com; HttpOnly; Secure; SameSite=Lax',
              'oai-client-auth-info=info-123; Path=/; Domain=chatgpt.com; HttpOnly; Secure; SameSite=Lax',
            ].join(', '),
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
            WARNING_BANNER: 'banner',
            user: { id: 'user-123', email: 'test.user@agentmail.to' },
            expires: '2026-03-17T00:00:00.000Z',
            account: { id: 'acct-123' },
            accessToken: 'access-123',
            authProvider: 'openai',
            sessionToken: 'session-token-123',
          }),
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    };

    const result = await replayOpenAiAuthFlow({
      email: 'test.user@agentmail.to',
      mode: 'existing-login-otp',
      fetchImpl,
      otpProvider: async () => ({ otp: '123456', receivedAtMs: Date.parse('2026-03-16T20:00:01.000Z') }),
      now: () => new Date('2026-03-16T20:00:00.000Z'),
    });

    expect(result.branch).toBe('existing-login-otp');
    expect(result.verdict).toBe('authenticated');
    expect(result.steps.map((step) => step.name)).toEqual([
      'bootstrap_login_with',
      'bootstrap_providers',
      'bootstrap_csrf',
      'bootstrap_signin_openai',
      'authorize_with_login_hint',
      'load_email_verification',
      'email_otp_validate',
      'chatgpt_callback',
      'chatgpt_callback_redirect',
      'chatgpt_session',
    ]);
    expect(result.finalSession.hasAccessToken).toBe(true);
    expect(result.finalSession.userEmail).toBe('test.user@agentmail.to');
    expect(result.finalCookies.cookies.some((cookie) => cookie.name === '__Secure-next-auth.session-token')).toBe(true);
    expect(result.steps[3].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.steps[3].responseHeaders['openai-processing-ms']).toBe('321');
    expect(result.steps[3].responseHeaders['x-request-id']).toBe('req-signin-123');
    expect(requests.find((request) => request.url === 'https://auth.openai.com/api/accounts/email-otp/validate')).toBeDefined();
  });

  test('runs a browserless signup flow with live sentinel headers through final authenticated ChatGPT session', async () => {
    const fetchImpl = async (url, options = {}) => {
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
          text: async () => '{"url":"https://auth.openai.com/api/accounts/authorize?client_id=app_X8zY6vW2pQ9tR3dE7nK1jL5gH&state=state-123&screen_hint=login&prompt=login"}',
        };
      }
      if (url.startsWith('https://auth.openai.com/api/accounts/authorize?')) {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/create-account/password',
            'set-cookie': 'login_session=session-123; Domain=auth.openai.com; Path=/; HttpOnly; Secure; SameSite=Lax',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/create-account/password') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          text: async () => '<html>create password</html>',
        };
      }
      if (url === 'https://sentinel.openai.com/backend-api/sentinel/req') {
        const body = JSON.parse(options.body);
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            persona: 'chatgpt-noauth',
            token: body.flow === 'username_password_create' ? 'live-sentinel-register' : 'live-sentinel-create',
            expire_after: 120,
            expire_at: 1773692720,
            turnstile: {},
            proofofwork: {},
          }),
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/user/register') {
        const sentinelToken = JSON.parse(options.headers['openai-sentinel-token']);
        expect(sentinelToken.c).toBe('live-sentinel-register');
        expect(sentinelToken.flow).toBe('username_password_create');
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"https://auth.openai.com/api/accounts/email-otp/send","method":"GET","page":{"type":"email_otp_send"}}',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/email-otp/send') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/email-verification',
            'set-cookie': 'hydra_redirect=redirect-123; Domain=auth.openai.com; Path=/; HttpOnly; Secure; SameSite=Lax',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/email-verification') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          text: async () => '<html>email verification</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/email-otp/validate') {
        expect(options.body).toBe('{"code":"654321"}');
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"https://auth.openai.com/about-you","method":"GET","page":{"type":"about_you"}}',
        };
      }
      if (url === 'https://auth.openai.com/about-you') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          text: async () => '<html>about you</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/create_account') {
        const sentinelToken = JSON.parse(options.headers['openai-sentinel-token']);
        const sentinelSoToken = JSON.parse(options.headers['openai-sentinel-so-token']);
        expect(sentinelToken.c).toBe('live-sentinel-create');
        expect(sentinelToken.flow).toBe('oauth_create_account');
        expect(sentinelSoToken.c).toBe('live-sentinel-create');
        expect(JSON.parse(options.body)).toEqual({ name: 'Codex Agent', birthdate: '2003-03-15' });
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"https://chatgpt.com/api/auth/callback/openai?code=code-123&state=state-123","method":"GET","page":{"type":"external_url"}}',
        };
      }
      if (url === 'https://chatgpt.com/api/auth/callback/openai?code=code-123&state=state-123') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://chatgpt.com/auth/login_with',
            'set-cookie': '__Secure-next-auth.session-token=session-token-123; Path=/; Domain=.chatgpt.com; HttpOnly; Secure; SameSite=Lax',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://chatgpt.com/auth/login_with') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          text: async () => '<html>login_with callback</html>',
        };
      }
      if (url === 'https://chatgpt.com/api/auth/session') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
          text: async () => JSON.stringify({
            WARNING_BANNER: 'banner',
            user: { id: 'user-234', email: 'fresh.signup@agentmail.to' },
            expires: '2026-03-17T00:00:00.000Z',
            account: { id: 'acct-234' },
            accessToken: 'access-234',
            authProvider: 'openai',
            sessionToken: 'session-token-123',
          }),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    const result = await replayOpenAiAuthFlow({
      email: 'fresh.signup@agentmail.to',
      mode: 'signup-new',
      fetchImpl,
      otpProvider: async ({ sinceMs }) => ({ otp: '654321', receivedAtMs: sinceMs + 1000 }),
      sentinelProvider: {
        buildHeadersForPath: async (requestPath) => ({
          headers: requestPath === '/api/accounts/user/register'
            ? {
                'openai-sentinel-token': JSON.stringify({
                  p: 'header-payload-register',
                  t: 'header-proof-register',
                  c: 'live-sentinel-register',
                  id: 'device-123',
                  flow: 'username_password_create',
                }),
              }
            : {
                'openai-sentinel-token': JSON.stringify({
                  p: 'header-payload-create',
                  t: 'header-proof-create',
                  c: 'live-sentinel-create',
                  id: 'device-123',
                  flow: 'oauth_create_account',
                }),
                'openai-sentinel-so-token': JSON.stringify({
                  so: 'so-token',
                  c: 'live-sentinel-create',
                  id: 'device-123',
                  flow: 'oauth_create_account',
                }),
              },
          flow: requestPath === '/api/accounts/user/register' ? 'username_password_create' : 'oauth_create_account',
          responseJson: {
            token: requestPath === '/api/accounts/user/register' ? 'live-sentinel-register' : 'live-sentinel-create',
          },
          step: {
            name: requestPath === '/api/accounts/user/register' ? 'sentinel_req_username_password_create' : 'sentinel_req_oauth_create_account',
            url: 'https://sentinel.openai.com/backend-api/sentinel/req',
            method: 'POST',
            requestedAt: '2026-03-16T20:00:00.000Z',
            status: 200,
            requestHeaders: { 'content-type': 'text/plain;charset=UTF-8' },
            requestBody: '{}',
            responseHeaders: { location: null, 'set-cookie': null, 'content-type': 'application/json' },
            responseJson: {
              token: requestPath === '/api/accounts/user/register' ? 'live-sentinel-register' : 'live-sentinel-create',
            },
            responseTextPreview: '{}',
          },
        }),
      },
      now: () => new Date('2026-03-16T20:00:00.000Z'),
    });

    expect(result.branch).toBe('signup-new');
    expect(result.verdict).toBe('authenticated');
    expect(result.steps.map((step) => step.name)).toEqual([
      'bootstrap_login_with',
      'bootstrap_providers',
      'bootstrap_csrf',
      'bootstrap_signin_openai',
      'authorize_with_login_hint',
      'load_create_account_password',
      'sentinel_req_username_password_create',
      'user_register',
      'email_otp_send',
      'load_email_verification',
      'email_otp_validate',
      'load_about_you',
      'sentinel_req_oauth_create_account',
      'create_account',
      'chatgpt_callback',
      'chatgpt_callback_redirect',
      'chatgpt_session',
    ]);
    expect(result.finalSession.hasAccessToken).toBe(true);
    expect(result.finalSession.userEmail).toBe('fresh.signup@agentmail.to');
    expect(result.latencyMs).toBe(0);
  });

  test('captures the OTP freshness timestamp before authorize triggers the email code', async () => {
    const baseMs = Date.parse('2026-03-16T20:00:00.000Z');
    const offsets = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000];
    let receivedSinceMs = null;

    const fetchImpl = async (url) => {
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
          text: async () => '{"url":"https://auth.openai.com/api/accounts/authorize?client_id=app_X8zY6vW2pQ9tR3dE7nK1jL5gH&state=state-123&screen_hint=login&prompt=login"}',
        };
      }
      if (url.startsWith('https://auth.openai.com/api/accounts/authorize?')) {
        return {
          status: 302,
          headers: new Headers({ location: 'https://auth.openai.com/email-verification' }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/email-verification') {
        return { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<html>email verification</html>' };
      }
      if (url === 'https://auth.openai.com/api/accounts/email-otp/validate') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"https://chatgpt.com/api/auth/callback/openai?code=code-123&state=state-123"}',
        };
      }
      if (url === 'https://chatgpt.com/api/auth/callback/openai?code=code-123&state=state-123') {
        return { status: 302, headers: new Headers({ location: 'https://chatgpt.com/auth/login_with' }), text: async () => '' };
      }
      if (url === 'https://chatgpt.com/api/auth/session') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"accessToken":"access-123","user":{"email":"test.user@agentmail.to"}}',
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    await replayOpenAiAuthFlow({
      email: 'test.user@agentmail.to',
      mode: 'existing-login-otp',
      fetchImpl,
      otpProvider: async ({ sinceMs }) => {
        receivedSinceMs = sinceMs;
        return { otp: '123456' };
      },
      now: () => new Date(baseMs + offsets.shift()),
    });

    expect(receivedSinceMs).toBe(baseMs + 4000);
  });
});
