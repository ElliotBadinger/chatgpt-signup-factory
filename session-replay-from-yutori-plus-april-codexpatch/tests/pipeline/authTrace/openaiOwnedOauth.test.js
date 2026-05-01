import { describe, test, expect, jest } from '@jest/globals';

import {
  acquireOwnedOpenAiOauth,
  buildOwnedOauthAuthorizeUrl,
} from '../../../src/pipeline/authTrace/openaiOwnedOauth.js';

function buildJwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
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
});