import { describe, test, expect, jest } from '@jest/globals';

import {
  acquireOwnedOpenAiOauth,
  buildOwnedOauthAuthorizeUrl,
} from '../../../src/pipeline/authTrace/openaiOwnedOauth.js';

function buildJwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

function buildSignedJsonCookie(payload) {
  return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

describe('buildOwnedOauthAuthorizeUrl', () => {
  test('matches the codex-lb desktop OAuth authorize shape', () => {
    const url = new URL(buildOwnedOauthAuthorizeUrl({
      state: 'state-123',
      codeChallenge: 'challenge-123',
    }));

    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(url.searchParams.get('originator')).toBe('codex_chatgpt_desktop');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
  });
});

describe('acquireOwnedOpenAiOauth', () => {
  test('skips workspace selection when the incoming session already targets the requested workspace', async () => {
    const accessToken = buildJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-123',
        chatgpt_plan_type: 'team',
      },
      'https://api.openai.com/profile': {
        email: 'member@example.com',
        email_verified: true,
      },
    });
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://auth.openai.com/api/accounts/workspace/select') {
        throw new Error('workspace select should be skipped when auth session already targets workspace-123');
      }

      if (String(url).startsWith('https://auth.openai.com/oauth/authorize?')) {
        expect(options.headers.cookie).toContain('session=existing-auth-session');
        return {
          status: 302,
          headers: new Headers({
            location: 'http://localhost:1455/auth/callback?code=owned-code-skip-select&state=state-skip-select',
          }),
          text: async () => '',
        };
      }

      if (url === 'https://auth.openai.com/oauth/token') {
        expect(options.body).toContain('code=owned-code-skip-select');
        expect(options.body).toContain('code_verifier=verifier-skip-select');
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            access_token: accessToken,
            refresh_token: 'owned-refresh-skip-select',
            token_type: 'Bearer',
          }),
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await acquireOwnedOpenAiOauth({
      cookies: [
        { name: 'session', value: 'existing-auth-session', domain: 'auth.openai.com', path: '/' },
      ],
      email: 'member@example.com',
      workspaceId: 'workspace-123',
      session: {
        accessToken: 'tok_workspace',
        account: { id: 'workspace-123', planType: 'team', structure: 'workspace' },
        user: { email: 'member@example.com' },
      },
      state: 'state-skip-select',
      codeVerifier: 'verifier-skip-select',
      fetchImpl,
    });

    expect(result.refreshToken).toBe('owned-refresh-skip-select');
    expect(result.steps.map((step) => step.name)).toEqual([
      'owned_oauth_authorize',
      'owned_oauth_token_exchange',
    ]);
  });

  test('selects the workspace, follows the owned OAuth redirect, and exchanges a refresh-bearing token bundle', async () => {
    const accessToken = buildJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-123',
        chatgpt_plan_type: 'team',
      },
      'https://api.openai.com/profile': {
        email: 'member@example.com',
        email_verified: true,
      },
    });
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://auth.openai.com/api/accounts/workspace/select') {
        expect(options.method).toBe('POST');
        expect(options.headers['content-type']).toBe('application/json');
        expect(options.body).toBe(JSON.stringify({ workspace_id: 'workspace-123' }));
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"success":true}',
        };
      }

      if (String(url).startsWith('https://auth.openai.com/oauth/authorize?')) {
        expect(options.headers.cookie).toContain('session=existing-auth-session');
        return {
          status: 302,
          headers: new Headers({
            location: 'http://localhost:1455/auth/callback?code=owned-code-123&state=state-123',
          }),
          text: async () => '',
        };
      }

      if (url === 'https://auth.openai.com/oauth/token') {
        expect(options.method).toBe('POST');
        expect(options.body).toContain('grant_type=authorization_code');
        expect(options.body).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
        expect(options.body).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback');
        expect(options.body).toContain('code=owned-code-123');
        expect(options.body).toContain('code_verifier=verifier-123');
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            access_token: accessToken,
            refresh_token: 'owned-refresh-123',
            id_token: 'id-token-123',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await acquireOwnedOpenAiOauth({
      cookies: [
        { name: 'session', value: 'existing-auth-session', domain: 'auth.openai.com', path: '/' },
      ],
      email: 'member@example.com',
      workspaceId: 'workspace-123',
      state: 'state-123',
      codeVerifier: 'verifier-123',
      now: () => new Date('2026-03-30T19:15:00.000Z'),
      fetchImpl,
    });

    expect(result).toEqual(expect.objectContaining({
      accessToken,
      refreshToken: 'owned-refresh-123',
      idToken: 'id-token-123',
      accountId: 'workspace-123',
      planType: 'team',
      identityEmail: 'member@example.com',
    }));
    expect(result.steps.map((step) => step.name)).toEqual([
      'owned_oauth_workspace_select',
      'owned_oauth_authorize',
      'owned_oauth_token_exchange',
    ]);
  });

  test('follows intermediate owned OAuth redirects before the localhost callback', async () => {
    const accessToken = buildJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-123',
        chatgpt_plan_type: 'team',
      },
      'https://api.openai.com/profile': {
        email: 'member@example.com',
        email_verified: true,
      },
    });
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (String(url).startsWith('https://auth.openai.com/oauth/authorize?')) {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/api/oauth/oauth2/auth?client_id=app_EMoamEEZ73f0CkXaXp7hrann',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/api/oauth/oauth2/auth?client_id=app_EMoamEEZ73f0CkXaXp7hrann') {
        expect(options.headers.cookie).toContain('session=existing-auth-session');
        return {
          status: 302,
          headers: new Headers({
            location: 'http://localhost:1455/auth/callback?code=owned-code-redirect&state=state-redirect',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        expect(options.body).toContain('code=owned-code-redirect');
        expect(options.body).toContain('code_verifier=verifier-redirect');
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            access_token: accessToken,
            refresh_token: 'owned-refresh-redirect',
            token_type: 'Bearer',
          }),
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await acquireOwnedOpenAiOauth({
      cookies: [
        { name: 'session', value: 'existing-auth-session', domain: 'auth.openai.com', path: '/' },
      ],
      email: 'member@example.com',
      state: 'state-redirect',
      codeVerifier: 'verifier-redirect',
      fetchImpl,
    });

    expect(result.refreshToken).toBe('owned-refresh-redirect');
    expect(result.steps.map((step) => step.name)).toEqual([
      'owned_oauth_authorize',
      'owned_oauth_authorize_redirect_1',
      'owned_oauth_token_exchange',
    ]);
  });

  test('fails closed when requested workspace selection is rejected before owned OAuth authorize', async () => {
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://auth.openai.com/api/accounts/workspace/select') {
        return {
          status: 409,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"error":"invalid_workspace_selected"}',
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(acquireOwnedOpenAiOauth({
      cookies: [
        { name: 'session', value: 'existing-auth-session', domain: 'auth.openai.com', path: '/' },
      ],
      email: 'member@example.com',
      workspaceId: 'workspace-123',
      state: 'state-123',
      codeVerifier: 'verifier-123',
      fetchImpl,
    })).rejects.toThrow('Owned OAuth workspace select failed for member@example.com: 409 invalid_workspace_selected');
  });

  test('fails closed when the owned OAuth token binds a different workspace than requested', async () => {
    const accessToken = buildJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-other',
        chatgpt_plan_type: 'team',
      },
      'https://api.openai.com/profile': {
        email: 'member@example.com',
        email_verified: true,
      },
    });
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (url === 'https://auth.openai.com/api/accounts/workspace/select') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"success":true}',
        };
      }
      if (String(url).startsWith('https://auth.openai.com/oauth/authorize?')) {
        return {
          status: 302,
          headers: new Headers({
            location: 'http://localhost:1455/auth/callback?code=owned-code-123&state=state-123',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            access_token: accessToken,
            refresh_token: 'owned-refresh-123',
            token_type: 'Bearer',
          }),
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(acquireOwnedOpenAiOauth({
      cookies: [
        { name: 'session', value: 'existing-auth-session', domain: 'auth.openai.com', path: '/' },
      ],
      email: 'member@example.com',
      workspaceId: 'workspace-123',
      state: 'state-123',
      codeVerifier: 'verifier-123',
      fetchImpl,
    })).rejects.toThrow('Owned OAuth workspace mismatch for member@example.com: expected workspace-123, got workspace-other');
  });

  test('resolves relative owned OAuth redirects and reset-password continuation URLs', async () => {
    const accessToken = buildJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-123',
        chatgpt_plan_type: 'team',
      },
      'https://api.openai.com/profile': {
        email: 'member@example.com',
        email_verified: true,
      },
    });
    const seenUrls = [];
    const fetchImpl = jest.fn(async (url, options = {}) => {
      seenUrls.push(String(url));
      if (String(url).startsWith('https://auth.openai.com/oauth/authorize?')) {
        return {
          status: 302,
          headers: new Headers({
            location: '/api/oauth/oauth2/auth?client_id=app_EMoamEEZ73f0CkXaXp7hrann',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/api/oauth/oauth2/auth?client_id=app_EMoamEEZ73f0CkXaXp7hrann') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-relative',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-relative') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/log-in',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/log-in') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>log-in</html>',
        };
      }
      if (url === 'https://auth.openai.com/reset-password') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>reset password</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/password/send-otp') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"/email-verification"}',
        };
      }
      if (url === 'https://auth.openai.com/email-verification') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>email verification</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/email-otp/validate') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"/reset-password/new-password"}',
        };
      }
      if (url === 'https://auth.openai.com/reset-password/new-password') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>new password</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/password/reset') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"/auth/callback?code=owned-code-relative&state=state-relative"}',
        };
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        expect(options.body).toContain('code=owned-code-relative');
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            access_token: accessToken,
            refresh_token: 'owned-refresh-relative',
            token_type: 'Bearer',
          }),
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await acquireOwnedOpenAiOauth({
      cookies: [
        { name: 'session', value: 'existing-auth-session', domain: 'auth.openai.com', path: '/' },
      ],
      email: 'member@example.com',
      state: 'state-relative',
      codeVerifier: 'verifier-relative',
      otpProvider: async () => ({ otp: '123456' }),
      fetchImpl,
    });

    expect(result.refreshToken).toBe('owned-refresh-relative');
    expect(seenUrls).toContain('https://auth.openai.com/api/oauth/oauth2/auth?client_id=app_EMoamEEZ73f0CkXaXp7hrann');
    expect(seenUrls).toContain('https://auth.openai.com/reset-password');
    expect(seenUrls).toContain('https://auth.openai.com/email-verification');
    expect(seenUrls).toContain('https://auth.openai.com/reset-password/new-password');
  });

  test('completes owned OAuth through reset-password continuation when password login is invalid', async () => {
    const accessToken = buildJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-123',
        chatgpt_plan_type: 'team',
      },
      'https://api.openai.com/profile': {
        email: 'member@example.com',
        email_verified: true,
      },
    });
    const seenUrls = [];
    const fetchImpl = jest.fn(async (url, options = {}) => {
      seenUrls.push(String(url));
      if (String(url).startsWith('https://auth.openai.com/oauth/authorize?')) {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/api/oauth/oauth2/auth?client_id=app_EMoamEEZ73f0CkXaXp7hrann',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/api/oauth/oauth2/auth?client_id=app_EMoamEEZ73f0CkXaXp7hrann') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-123',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-123') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/log-in',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/log-in') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>log-in</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/password/login') {
        expect(options.method).toBe('POST');
        expect(options.body).toBe(JSON.stringify({ username: 'member@example.com' }));
        expect(options.headers.referer).toBe('https://auth.openai.com/log-in/password');
        return {
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"error":{"message":"Invalid URL (POST /password/login)"}}',
        };
      }
      if (url === 'https://auth.openai.com/reset-password') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>reset password</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/password/send-otp') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"https://auth.openai.com/email-verification"}',
        };
      }
      if (url === 'https://auth.openai.com/email-verification') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>email verification</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/email-otp/validate') {
        expect(options.body).toBe(JSON.stringify({ code: '123456' }));
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"https://auth.openai.com/reset-password/new-password"}',
        };
      }
      if (url === 'https://auth.openai.com/reset-password/new-password') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>new password</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/password/reset') {
        expect(options.body).toBe(JSON.stringify({ password: 'Replay!memberA9' }));
        expect(options.headers.referer).toBe('https://auth.openai.com/reset-password/new-password');
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"http://localhost:1455/auth/callback?code=owned-code-login&state=state-login"}',
        };
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        expect(options.body).toContain('code=owned-code-login');
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            access_token: accessToken,
            refresh_token: 'owned-refresh-login',
            token_type: 'Bearer',
          }),
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await acquireOwnedOpenAiOauth({
      cookies: [
        { name: 'session', value: 'existing-auth-session', domain: 'auth.openai.com', path: '/' },
      ],
      email: 'member@example.com',
      state: 'state-login',
      codeVerifier: 'verifier-login',
      otpProvider: async () => ({ otp: '123456' }),
      fetchImpl,
    });

    expect(result.refreshToken).toBe('owned-refresh-login');
    expect(seenUrls).toContain('https://auth.openai.com/reset-password');
    expect(result.steps.map((step) => step.name)).toEqual([
      'owned_oauth_authorize',
      'owned_oauth_authorize_redirect_1',
      'owned_oauth_authorize_redirect_2',
      'owned_oauth_authorize_redirect_3',
      'owned_oauth_load_reset_password',
      'owned_oauth_password_reset_send_otp',
      'owned_oauth_load_password_reset_email_verification',
      'owned_oauth_email_otp_validate_password_reset',
      'owned_oauth_load_password_reset_new_password',
      'owned_oauth_complete_password_reset',
      'owned_oauth_token_exchange',
    ]);
  });

  test('uses password add when reset continuation lands on post_login_add_password', async () => {
    const accessToken = buildJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-123',
        chatgpt_plan_type: 'team',
      },
      'https://api.openai.com/profile': {
        email: 'member@example.com',
        email_verified: true,
      },
    });
    const fetchImpl = jest.fn(async (url, options = {}) => {
      if (String(url).startsWith('https://auth.openai.com/oauth/authorize?')) {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/api/oauth/oauth2/auth?client_id=app_EMoamEEZ73f0CkXaXp7hrann',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/api/oauth/oauth2/auth?client_id=app_EMoamEEZ73f0CkXaXp7hrann') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-object-username',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-object-username') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/log-in',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/log-in') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>log-in</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/password/login') {
        return {
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"error":{"message":"Invalid URL (POST /password/login)"}}',
        };
      }
      if (url === 'https://auth.openai.com/reset-password') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>reset password</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/password/send-otp') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"https://auth.openai.com/email-verification"}',
        };
      }
      if (url === 'https://auth.openai.com/email-verification') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>email verification</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/email-otp/validate') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"https://auth.openai.com/reset-password/post_login_add_password"}',
        };
      }
      if (url === 'https://auth.openai.com/reset-password/post_login_add_password') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>add password</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/password/add') {
        expect(options.body).toBe(JSON.stringify({ password: 'Replay!memberA9' }));
        expect(options.headers.referer).toBe('https://auth.openai.com/reset-password/post_login_add_password');
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"continue_url":"http://localhost:1455/auth/callback?code=owned-code-object&state=state-object"}',
        };
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            access_token: accessToken,
            refresh_token: 'owned-refresh-object',
            token_type: 'Bearer',
          }),
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await acquireOwnedOpenAiOauth({
      cookies: [
        { name: 'session', value: 'existing-auth-session', domain: 'auth.openai.com', path: '/' },
      ],
      email: 'member@example.com',
      state: 'state-object',
      codeVerifier: 'verifier-object',
      otpProvider: async () => ({ otp: '123456' }),
      fetchImpl,
    });

    expect(result.refreshToken).toBe('owned-refresh-object');
    expect(result.steps.map((step) => step.name)).toContain('owned_oauth_complete_password_reset');
  });

  test('fails closed when password reset send-otp returns invalid_state and never waits for OTP', async () => {
    const otpProvider = jest.fn(async () => ({ otp: '123456' }));
    const fetchImpl = jest.fn(async (url) => {
      if (String(url).startsWith('https://auth.openai.com/oauth/authorize?')) {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/api/oauth/oauth2/auth?client_id=app_EMoamEEZ73f0CkXaXp7hrann',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/api/oauth/oauth2/auth?client_id=app_EMoamEEZ73f0CkXaXp7hrann') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-123',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-123') {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://auth.openai.com/log-in',
          }),
          text: async () => '',
        };
      }
      if (url === 'https://auth.openai.com/log-in') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>log-in</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/password/login') {
        return {
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"error":{"message":"Invalid URL (POST /password/login)"}}',
        };
      }
      if (url === 'https://auth.openai.com/reset-password') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html>reset password</html>',
        };
      }
      if (url === 'https://auth.openai.com/api/accounts/password/send-otp') {
        return {
          status: 409,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"error":"invalid_state","message":"state is stale"}',
        };
      }
      if (url === 'https://auth.openai.com/email-verification') {
        throw new Error('email verification should not load after invalid_state');
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(acquireOwnedOpenAiOauth({
      cookies: [
        { name: 'session', value: 'existing-auth-session', domain: 'auth.openai.com', path: '/' },
      ],
      email: 'member@example.com',
      state: 'state-login',
      codeVerifier: 'verifier-login',
      otpProvider,
      fetchImpl,
    })).rejects.toThrow('Owned OAuth password reset send-otp failed for member@example.com: 409 invalid_state');
    expect(otpProvider).not.toHaveBeenCalled();
  });
});
