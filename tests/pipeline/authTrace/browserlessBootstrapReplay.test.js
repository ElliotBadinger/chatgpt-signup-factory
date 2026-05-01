import { describe, expect, test } from '@jest/globals';

import { replayBrowserlessBootstrap } from '../../../src/pipeline/authTrace/browserlessBootstrapReplay.js';

describe('replayBrowserlessBootstrap', () => {
  test('replays bootstrap sequence with cookie jar and captures outcomes', async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      if (url === 'https://chatgpt.com/auth/login_with') {
        return {
          status: 200,
          headers: new Headers({ 'set-cookie': 'cf_clearance=clear456; Path=/; Domain=chatgpt.com' }),
          text: async () => '<html>login_with</html>',
        };
      }
      if (url === 'https://chatgpt.com/api/auth/providers') {
        return {
          status: 200,
          headers: new Headers({}),
          text: async () => '{"openai":{}}',
        };
      }
      if (url === 'https://chatgpt.com/api/auth/csrf') {
        return {
          status: 200,
          headers: new Headers({ 'set-cookie': '__Secure-next-auth.callback-url=https%3A%2F%2Fchatgpt.com%2Fauth%2Flogin_with; Path=/; HttpOnly' }),
          text: async () => '{"csrfToken":"csrf-value"}',
        };
      }
      if (url === 'https://chatgpt.com/api/auth/signin/openai?prompt=login') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json', 'set-cookie': '__Secure-next-auth.state=state-999; Path=/; HttpOnly' }),
          text: async () => '{"url":"https://auth.openai.com/api/accounts/authorize?prompt=login"}',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/authorize?prompt=login') {
        return {
          status: 302,
          headers: new Headers({
            'content-type': 'text/html',
            location: 'https://auth.openai.com/log-in',
            'set-cookie': [
              '__Secure-next-auth.state=state-999; Path=/; HttpOnly',
              'login_session=session-123; Domain=auth.openai.com; Path=/; Expires=Mon, 16 Mar 2026 20:48:39 GMT; HttpOnly; Secure; SameSite=Lax',
              'hydra_redirect=redirect-123; Domain=auth.openai.com; Path=/; Expires=Mon, 16 Mar 2026 20:48:39 GMT; HttpOnly; Secure; SameSite=Lax',
            ].join(', '),
          }),
          text: async () => '',
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    const result = await replayBrowserlessBootstrap({
      plan: {
        cookieJar: {
          cookies: [
            { name: '__Host-next-auth.csrf-token', value: 'csrf-value|hash', domain: 'chatgpt.com', path: '/' },
            { name: '__Secure-next-auth.callback-url', value: 'https://chatgpt.com', domain: 'chatgpt.com', path: '/' },
          ],
        },
        sequence: [
          { name: 'login_with', method: 'GET', url: 'https://chatgpt.com/auth/login_with' },
          { name: 'providers', method: 'GET', url: 'https://chatgpt.com/api/auth/providers' },
          { name: 'csrf', method: 'GET', url: 'https://chatgpt.com/api/auth/csrf' },
          {
            name: 'signin_openai',
            method: 'POST',
            url: 'https://chatgpt.com/api/auth/signin/openai?prompt=login',
            bodyTemplate: 'callbackUrl=https%3A%2F%2Fchatgpt.com%2Fauth%2Flogin_with&csrfToken={{csrfToken}}&json=true',
            contentType: 'application/x-www-form-urlencoded',
          },
          { name: 'authorize_prompt_login', method: 'GET', url: 'https://auth.openai.com/api/accounts/authorize?prompt=login', usePreviousJsonUrl: true },
        ],
        csrfToken: 'stale-token',
      },
      fetchImpl,
      now: () => new Date('2026-03-16T20:00:00.000Z'),
    });

    expect(result.steps).toHaveLength(5);
    expect(result.steps[0].status).toBe(200);
    expect(result.steps[3].responseJson.url).toContain('/authorize?prompt=login');
    expect(result.finalCookies.cookies.find((cookie) => cookie.name === 'cf_clearance').value).toBe('clear456');
    expect(result.finalCookies.cookies.find((cookie) => cookie.name === 'login_session').value).toBe('session-123');
    expect(result.finalCookies.cookies.find((cookie) => cookie.name === 'hydra_redirect').value).toBe('redirect-123');
    expect(requests[1].options.headers.cookie).toContain('cf_clearance=clear456');
    expect(requests[3].options.body).toContain('csrfToken=csrf-value');
    expect(requests[4].url).toBe('https://auth.openai.com/api/accounts/authorize?prompt=login');
    expect(result.steps[4].responseHeaders.location).toBe('https://auth.openai.com/log-in');
  });
});
